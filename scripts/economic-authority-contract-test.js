#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/economic-authority-contract.
//
// Fixture pricing only. No database, no server, no provider, no network. The
// fixture rates below are illustrative and exist solely to exercise arithmetic;
// a source assertion at the end proves no production catalog ships.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ECONOMIC_AUTHORITY_FIELDS,
  ECONOMIC_AUTHORITY_VERSION,
  ECONOMIC_POLICY_FIELDS,
  ECONOMIC_POLICY_VERSION,
  ECONOMIC_REFUSALS,
  ECONOMIC_UNIT,
  EconomicAuthorityError,
  assertAuthorityMatchesRoutingDecision,
  buildEconomicAuthority,
  buildEconomicPolicy,
  normalizeEconomicAuthority,
  normalizeEconomicPolicy
} = require('../runtime/economic-authority-contract');
const {
  buildRoleRoutingDecision,
  buildRoleRoutingPolicy
} = require('../runtime/role-routing-contract');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

const OPENAI_ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';       // 128,000 ctx / 16,384 max output
const OTHER_SNAPSHOT = 'gpt-4.1-mini-2025-04-14'; // 1,047,576 ctx / 32,768 max output
const ATTEMPT_ID = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41';
const AT = '2026-08-01T00:00:00.000Z';

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

function zeroCatalog(model = SNAPSHOT) {
  return buildPricingCatalog({
    catalogId: 'fixture-zero',
    entries: [{
      provider: 'openai',
      model,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 0,
      outputMicroUsdPerMillionTokens: 0,
      requestMicroUsd: 0,
      boundMethod: 'catalog_maximum_exactly_zero'
    }]
  });
}

function routingPolicyOf(model = SNAPSHOT, role = 'structured_leaf_executor') {
  return buildRoleRoutingPolicy({
    policyId: 'routing-policy-1',
    rolePolicies: [{
      role,
      primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model },
      fallbackRoute: null,
      authorizedFallbackReasons: []
    }]
  });
}

function workerRoute(model = SNAPSHOT, extra = {}) {
  return buildRoleRoutingDecision({
    policy: routingPolicyOf(model),
    role: 'structured_leaf_executor',
    ticketId: 7,
    subjectKind: 'run',
    subjectId: 42,
    actingAgentId: 12,
    decidedAt: AT,
    ...extra
  });
}

function plannerRoute(model = SNAPSHOT) {
  return buildRoleRoutingDecision({
    policy: routingPolicyOf(model, 'structured_planner'),
    role: 'structured_planner',
    ticketId: 7,
    subjectKind: 'planning_attempt',
    subjectId: ATTEMPT_ID,
    actingAgentId: 11,
    decidedAt: AT
  });
}

function policyOf(catalog, overrides = {}) {
  return buildEconomicPolicy({
    policyId: 'economic-policy-1',
    role: 'structured_leaf_executor',
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
}

function authorityOf(policy, routingDecision, pricingCatalog) {
  return buildEconomicAuthority({ policy, routingDecision, pricingCatalog, capturedAt: AT });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof EconomicAuthorityError, 'refusals use the module error');
    assert.equal(error.code, 'ECONOMIC_AUTHORITY_REFUSED');
    assert.equal(ECONOMIC_REFUSALS.includes(error.reason), true,
      `${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected an economic refusal');
}

function invalid(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail('expected a contract violation');
}

// ── (1) Economic policy is closed and deterministically hashed ──────────────

assert.equal(ECONOMIC_UNIT, 'micro_usd');
const catalog = catalogOf();
const policy = policyOf(catalog);
assert.equal(policy.version, ECONOMIC_POLICY_VERSION);
assert.deepEqual(Object.keys(policy).sort(), [...ECONOMIC_POLICY_FIELDS].sort());
assert.equal(Object.isFrozen(policy), true);
assert.equal(policyOf(catalog).policyHash, policy.policyHash, 'policy hashing is deterministic');
assert.equal(normalizeEconomicPolicy(policy).policyHash, policy.policyHash);
assert.equal(normalizeEconomicPolicy(JSON.parse(JSON.stringify(policy))).policyHash,
  policy.policyHash, 'a policy survives a JSONB round trip');
assert.equal(refusalReason(() => normalizeEconomicPolicy({ ...policy, policyHash: '0'.repeat(64) })),
  'economic_policy_malformed');

// The policy owns no route: it names no provider, model, adapter or agent.
for (const routeField of [
  'provider', 'model', 'adapterId', 'actingAgentId', 'dispatchTarget',
  'primaryRoute', 'fallbackRoute', 'credentials', 'reservedMicroUsd', 'settledMicroUsd'
]) {
  assert.equal(ECONOMIC_POLICY_FIELDS.includes(routeField), false,
    `the economic policy must not contain ${routeField}`);
}
assert.equal(ECONOMIC_POLICY_FIELDS.includes('maxCost'), false,
  'the legacy ambiguous maxCost is never reinterpreted');

// ── (2)(3)(4) Hash independence between routing and economics ───────────────

const routingPolicy = routingPolicyOf();
const decision = workerRoute();

// (2) Every economic dimension changes the economic-policy hash.
for (const [field, value] of [
  ['authorizedMicroUsd', 500_001],
  ['maximumProviderRequests', 9],
  ['maximumOutputTokensPerRequest', 2_049],
  ['fallbackLiabilityAuthorized', true]
]) {
  const changed = policyOf(catalog, field === 'fallbackLiabilityAuthorized'
    ? { fallbackLiabilityAuthorized: true, fallbackProviderRequests: 1 }
    : { [field]: value });
  assert.notEqual(changed.policyHash, policy.policyHash,
    `${field} changes the economic-policy hash`);
}
// Pricing authority is an economic dimension too.
assert.notEqual(policyOf(catalogOf({}, 'other-catalog')).policyHash, policy.policyHash);

// (3) None of that touches routing.
const budgetChanged = policyOf(catalog, { authorizedMicroUsd: 499_999 });
assert.equal(routingPolicyOf().policyHash, routingPolicy.policyHash,
  'a budget change leaves the routing-policy hash identical');
assert.equal(workerRoute().decisionHash, decision.decisionHash,
  'a budget change leaves the routing-decision hash identical');
assert.notEqual(
  authorityOf(budgetChanged, decision, catalog).authorityHash,
  authorityOf(policy, decision, catalog).authorityHash,
  'but it DOES change the economic authority'
);
assert.notEqual(budgetChanged.policyHash, policy.policyHash);

// (4) A route change moves the routing hashes.
assert.notEqual(routingPolicyOf(OTHER_SNAPSHOT).policyHash, routingPolicy.policyHash);
assert.notEqual(workerRoute(OTHER_SNAPSHOT).decisionHash, decision.decisionHash);

// ── (5) Authority binds the routing decision ────────────────────────────────

const authority = authorityOf(policy, decision, catalog);
assert.equal(authority.version, ECONOMIC_AUTHORITY_VERSION);
assert.deepEqual(Object.keys(authority).sort(), [...ECONOMIC_AUTHORITY_FIELDS].sort());
assert.equal(authority.routingDecisionHash, decision.decisionHash);
assert.equal(authority.dispatchTarget, decision.dispatchTarget);
assert.equal(authority.targetEvidenceHash, decision.targetEvidenceHash);
assert.equal(Object.isFrozen(authority), true);
assert.equal(assertAuthorityMatchesRoutingDecision(authority, decision).authorityHash,
  authority.authorityHash);

// Mutable facts stay OUT of the authority.
for (const mutable of [
  'reservedMicroUsd', 'settledMicroUsd', 'remainingMicroUsd', 'accountId',
  'requestState', 'usage', 'settlement', 'receipt', 'recoveryState'
]) {
  assert.equal(ECONOMIC_AUTHORITY_FIELDS.includes(mutable), false,
    `${mutable} is mutable and must not be inside the authority hash`);
}

// ── (6)(7)(8) Transplant refusal ────────────────────────────────────────────

assert.equal(
  refusalReason(() => assertAuthorityMatchesRoutingDecision(authority, workerRoute(OTHER_SNAPSHOT))),
  'routing_decision_mismatch',
  'an authority cannot be paired with another routing decision'
);
assert.equal(
  refusalReason(() => normalizeEconomicAuthority(authority, { expectedTicketId: 8 })),
  'routing_decision_mismatch', 'ticket transplant refuses');
assert.equal(
  refusalReason(() => normalizeEconomicAuthority(authority, { expectedRole: 'structured_planner' })),
  'routing_decision_mismatch', 'role transplant refuses');
assert.equal(
  refusalReason(() => normalizeEconomicAuthority(authority,
    { expectedRoutingDecisionHash: '0'.repeat(64) })),
  'routing_decision_mismatch');
// A policy governing one role cannot authorize another role's route.
assert.equal(
  refusalReason(() => authorityOf(policy, plannerRoute(), catalog)),
  'economic_policy_role_mismatch'
);
// The catalog the policy named is the catalog it is priced against.
assert.equal(
  refusalReason(() => authorityOf(policy, decision, catalogOf({}, 'a-different-catalog'))),
  'pricing_catalog_mismatch'
);

// ── (9) Subject shape ───────────────────────────────────────────────────────

assert.equal(authority.subjectKind, 'run');
assert.equal(authority.runId, 42);
assert.equal(authority.planningAttemptId, null);
const plannerPolicy = policyOf(catalog, {
  policyId: 'economic-policy-planner', role: 'structured_planner', maximumProviderRequests: 1
});
const plannerAuthority = authorityOf(plannerPolicy, plannerRoute(), catalog);
assert.equal(plannerAuthority.subjectKind, 'planning_attempt');
assert.equal(plannerAuthority.planningAttemptId, ATTEMPT_ID);
assert.equal(plannerAuthority.runId, null);
// Exactly one subject: both or neither is unrepresentable. Tampering with the
// subject fields also breaks the authority hash, so the hash gate catches it
// first — the stronger of the two guarantees.
for (const shape of [
  { planningAttemptId: ATTEMPT_ID, runId: 42 },
  { planningAttemptId: null, runId: null },
  { role: 'structured_planner', planningAttemptId: ATTEMPT_ID, runId: null }
]) {
  invalid(() => normalizeEconomicAuthority({ ...authority, ...shape }));
}
// The shape rule itself is enforced at BUILD time, independently of any hash: a
// planner policy cannot capture a Run subject, and a worker policy cannot
// capture a planning attempt.
// A role mismatch is caught first and named precisely.
assert.equal(
  refusalReason(() => authorityOf(plannerPolicy, decision, catalog)),
  'economic_policy_role_mismatch',
  'a planner policy cannot govern a worker routing decision'
);
// With the roles agreeing, a wrong subject KIND is still refused on its own.
const plannerRouteWithRunSubject = buildRoleRoutingDecision({
  policy: routingPolicyOf(SNAPSHOT, 'structured_planner'),
  role: 'structured_planner',
  ticketId: 7,
  subjectKind: 'run',
  subjectId: 42,
  actingAgentId: 11,
  decidedAt: AT
});
assert.equal(
  refusalReason(() => authorityOf(plannerPolicy, plannerRouteWithRunSubject, catalog)),
  'economic_subject_shape_invalid',
  'a planner authority requires a planning-attempt subject'
);

// ── (10)(15)(16)(17) Paid snapshot prices the full ceiling ──────────────────

// input  128,000 ctx × 150_000/1e6 = 19,200 ; output 2,048 × 600_000/1e6 = 1,229 (rounded up)
assert.equal(authority.boundMethod, 'model_context_window_ceiling');
assert.equal(authority.contextWindowTokens, 128_000);
assert.equal(authority.maximumOutputTokensPerRequest, 2_048);
assert.equal(authority.maximumPerRequestMicroUsd, 20_429);
assert.equal(authority.maximumTotalMicroUsd, 163_432, '8 requests × 20,429');
assert.notEqual(authority.modelCapabilityHash, null, 'a paid route binds its model capability');
// The output cap is NOT subtracted from the context ceiling.
assert.equal(
  authority.contextWindowTokens + authority.maximumOutputTokensPerRequest > 128_000, true);
// A fixed per-request charge is included. The policy must be priced against the
// same catalog it is used with — a mismatch is its own refusal, proven above.
const fixedCatalog = catalogOf({ requestMicroUsd: 500 });
assert.equal(
  authorityOf(policyOf(fixedCatalog), decision, fixedCatalog).maximumPerRequestMicroUsd,
  20_929
);
// (19) Upward rounding: one output token at 600,000/Mtok is 1 micro-USD, not 0.
assert.equal(
  authorityOf(policyOf(catalog, { maximumOutputTokensPerRequest: 1, maximumProviderRequests: 1 }),
    decision, catalog).maximumPerRequestMicroUsd,
  19_201,
  'a sub-unit output charge rounds up rather than vanishing'
);

// ── (18) Fallback liability only when authorized ────────────────────────────

assert.equal(authority.fallbackMaximumMicroUsd, 0);
const withFallback = policyOf(catalog, {
  fallbackLiabilityAuthorized: true, fallbackProviderRequests: 1
});
const fallbackAuthority = authorityOf(withFallback, decision, catalog);
assert.equal(fallbackAuthority.fallbackMaximumMicroUsd, 20_429);
assert.equal(fallbackAuthority.maximumTotalMicroUsd, 183_861, '9 chargeable requests');
assert.equal(
  refusalReason(() => policyOf(catalog, {
    fallbackLiabilityAuthorized: false, fallbackProviderRequests: 1
  })),
  'fallback_liability_not_authorized',
  'fallback liability cannot exist without explicit authorization'
);

// ── (11)(12) Distinct refusal layers ────────────────────────────────────────

// A capturable route with no price refuses for PRICING, not routing.
assert.throws(
  () => authorityOf(policyOf(zeroCatalog(OTHER_SNAPSHOT)), decision, zeroCatalog(OTHER_SNAPSHOT)),
  error => error.reason === 'pricing_entry_missing',
  'a capturable route with no price refuses for PRICING, not routing'
);
// A paid route whose model has no runtime capability refuses economically. The
// pricing catalog itself refuses to admit such an entry at all.
assert.throws(
  () => buildPricingCatalog({
    catalogId: 'bad',
    entries: [{
      provider: 'openai', model: 'gpt-9-preview-2099-01-01', adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token', inputMicroUsdPerMillionTokens: 1,
      outputMicroUsdPerMillionTokens: 1, requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling'
    }]
  }),
  error => error.reason === 'model_capability_unknown',
  'a paid unknown model refuses economically, with an economic reason'
);
// Exceeding the authorized amount is its own refusal.
assert.equal(
  refusalReason(() => authorityOf(policyOf(catalog, { authorizedMicroUsd: 1_000 }),
    decision, catalog)),
  'economic_authority_exceeded'
);
// Each refusal is distinct — none is a generic catch-all.
assert.equal(new Set([
  'pricing_entry_missing', 'model_capability_unknown',
  'provider_path_not_hard_boundable', 'economic_authority_exceeded'
]).size, 4);

// ── (13)(14) Explicitly zero-priced route ───────────────────────────────────

const zero = zeroCatalog();
const zeroPolicy = policyOf(zero, { policyId: 'economic-policy-zero' });
const zeroAuthority = authorityOf(zeroPolicy, decision, zero);
assert.equal(zeroAuthority.boundMethod, 'catalog_maximum_exactly_zero');
assert.equal(zeroAuthority.maximumPerRequestMicroUsd, 0);
assert.equal(zeroAuthority.maximumTotalMicroUsd, 0);
assert.equal(zeroAuthority.contextWindowTokens, null,
  'a zero-priced route consults no context ceiling');
assert.equal(zeroAuthority.modelCapabilityHash, null,
  'a zero-priced route requires no model capability');
// But the immutable dispatch target is still mandatory: it came from a routing
// decision, and a route that cannot be captured never reaches economics at all.
assert.equal(zeroAuthority.dispatchTarget, SNAPSHOT);
assert.match(zeroAuthority.targetEvidenceHash, /^[0-9a-f]{64}$/);
// Removing the immutable-target evidence breaks the authority hash outright.
invalid(() => normalizeEconomicAuthority({ ...zeroAuthority, targetEvidenceHash: null }));

// ── (20) Unsafe integers and overflow ───────────────────────────────────────

for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
  invalid(() => policyOf(catalog, { authorizedMicroUsd: bad }));
}
invalid(() => policyOf(catalog, { authorizedMicroUsd: Number.MAX_SAFE_INTEGER + 2 }));
for (const bad of [0, -1, 1.5]) {
  invalid(() => policyOf(catalog, { maximumProviderRequests: bad }));
  invalid(() => policyOf(catalog, { maximumOutputTokensPerRequest: bad }));
}
// A rate large enough to overflow the safe-integer range refuses rather than
// wrapping to a smaller, affordable-looking number.
const overflowCatalog = catalogOf({ inputMicroUsdPerMillionTokens: Number.MAX_SAFE_INTEGER });
invalid(() => authorityOf(
  policyOf(overflowCatalog, { authorizedMicroUsd: Number.MAX_SAFE_INTEGER - 1 }),
  decision,
  overflowCatalog
));

// ── (21)(22)(23) Partial, unknown-field and tampered documents ──────────────

for (const field of ECONOMIC_POLICY_FIELDS) {
  const partial = { ...policy };
  delete partial[field];
  invalid(() => normalizeEconomicPolicy(partial));
}
invalid(() => normalizeEconomicPolicy({ ...policy, extra: 1 }));
invalid(() => normalizeEconomicPolicy({ ...policy, version: 2 }));
for (const field of ECONOMIC_AUTHORITY_FIELDS) {
  const partial = { ...authority };
  delete partial[field];
  invalid(() => normalizeEconomicAuthority(partial));
}
invalid(() => normalizeEconomicAuthority({ ...authority, extra: 1 }));
invalid(() => normalizeEconomicAuthority({ ...authority, version: 2 }));
for (const tampered of [
  'maximumTotalMicroUsd', 'maximumPerRequestMicroUsd', 'contextWindowTokens',
  'dispatchTarget', 'routingDecisionHash', 'pricingEntryHash', 'authorityHash'
]) {
  invalid(() => normalizeEconomicAuthority({
    ...authority,
    [tampered]: typeof authority[tampered] === 'number' ? authority[tampered] + 1 : '0'.repeat(64)
  }));
}
assert.equal(normalizeEconomicAuthority(JSON.parse(JSON.stringify(authority))).authorityHash,
  authority.authorityHash, 'an authority survives a JSONB round trip');

// ── (24) Drift does not rewrite a captured authority ────────────────────────

const repriced = catalogOf({ inputMicroUsdPerMillionTokens: 300_000 });
const repricedAuthority = authorityOf(policyOf(repriced), decision, repriced);
assert.notEqual(repricedAuthority.maximumTotalMicroUsd, authority.maximumTotalMicroUsd,
  'a NEW authority under the new catalog prices differently');
assert.equal(authority.maximumTotalMicroUsd, 163_432,
  'the already-captured authority is unchanged by catalog drift');
assert.equal(authority.pricingCatalogHash, catalog.catalogHash,
  'the captured authority keeps the catalog hash it was admitted under');
assert.notEqual(repricedAuthority.pricingCatalogHash, authority.pricingCatalogHash);

// ── (25) No production paid catalog ─────────────────────────────────────────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'economic-authority-contract.js'), 'utf8');
const executable = source.replace(/^\s*\/\/.*$/gm, '');
assert.equal(/MicroUsdPerMillionTokens:\s*[1-9]/.test(executable), false,
  'the module declares no rate of its own');
assert.equal(executable.includes('buildPricingCatalog('), false,
  'the module constructs no catalog of its own');
for (const forbidden of [
  'fetch(', 'require(\'http', 'https://', 'child_process', 'Math.random', 'Date.now',
  'parseFloat', 'toFixed', 'cheapest', 'optimi'
]) {
  assert.equal(executable.includes(forbidden), false,
    `economics stays static and integer-only: ${forbidden} must not appear`);
}
// One-way authority: economics consumes routing, never the reverse.
assert.equal(
  fs.readFileSync(path.join(__dirname, '..', 'runtime', 'role-routing-contract.js'), 'utf8')
    .includes('economic-authority-contract'),
  false,
  'routing must not import economics'
);

console.log('economic authority contract test passed');

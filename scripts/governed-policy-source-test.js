#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/governed-policy-source.
//
// No database, no server, no network, fixture prices only. This proves the
// separation the module exists for: the administrator container holds the
// configuration, but only the three closed subdocuments are authority.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  GOVERNED_POLICY_KEY,
  GOVERNED_POLICY_REFUSALS,
  GOVERNED_SUBDOCUMENTS,
  GovernedPolicySourceError,
  IGNORED_LEGACY_CONTAINER_FIELDS,
  SUBDOCUMENT_INPUT_FIELDS,
  readGovernedPolicySource
} = require('../runtime/governed-policy-source');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

const PLANNER = 'structured_planner';
const WORKER = 'structured_leaf_executor';
const ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const AT = '2026-08-01T00:00:00.000Z';

// Illustrative fixture rates. NOT production authority.
function catalogValue(overrides = {}) {
  return {
    catalogId: 'fixture-catalog',
    entries: [{
      provider: 'openai', model: SNAPSHOT, adapterId: ADAPTER, chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0, boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  };
}

function containerOf({ catalog = catalogValue(), role = PLANNER, legacy = {} } = {}) {
  const built = buildPricingCatalog(catalog);
  return {
    body: {
      name: 'Planner policy',
      status: 'active',
      // Legacy siblings. None of these may enter a governed hash.
      maxCost: { currency: 'USD', limit: 5 },
      maxLatency: { ms: 1_000 },
      allowedProviders: ['anthropic'],
      preferredProvider: 'anthropic',
      preferredModel: 'claude-legacy',
      fallbackProviders: ['ollama'],
      riskClass: 'standard',
      toolRequirements: [],
      targetRequirements: [],
      verificationRequirement: null,
      triageOnNoRoute: true,
      ...legacy,
      [GOVERNED_POLICY_KEY]: {
        roleRoutingPolicy: {
          policyId: 'routing-1',
          rolePolicies: [{
            role,
            primaryRoute: { adapterId: ADAPTER, provider: 'openai', model: SNAPSHOT },
            fallbackRoute: null,
            authorizedFallbackReasons: []
          }]
        },
        economicPolicy: {
          policyId: 'economics-1',
          role,
          authorizedMicroUsd: 500_000,
          maximumProviderRequests: 1,
          maximumOutputTokensPerRequest: 2_048,
          pricingCatalogId: built.catalogId,
          pricingCatalogHash: built.catalogHash,
          fallbackLiabilityAuthorized: false,
          fallbackProviderRequests: 0,
          capturedAt: AT
        },
        pricingCatalog: catalog
      }
    }
  };
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GovernedPolicySourceError, 'refusals use the module error');
    assert.equal(error.code, 'GOVERNED_POLICY_REFUSED');
    assert.equal(GOVERNED_POLICY_REFUSALS.includes(error.detail.reason), true,
      `${error.detail.reason} is in the closed vocabulary`);
    return error.detail.reason;
  }
  return assert.fail('expected a governed policy refusal');
}

// ── Three independent identities and hashes ─────────────────────────────────

const source = readGovernedPolicySource(containerOf(), { role: PLANNER });
assert.deepEqual([...GOVERNED_SUBDOCUMENTS],
  ['roleRoutingPolicy', 'economicPolicy', 'pricingCatalog']);
assert.equal(new Set([
  source.roleRoutingPolicyHash, source.economicPolicyHash, source.pricingCatalogHash
]).size, 3, 'the three documents hash independently');
for (const hash of [source.roleRoutingPolicyHash, source.economicPolicyHash,
  source.pricingCatalogHash]) {
  assert.match(hash, /^[0-9a-f]{64}$/);
}
assert.equal(source.roleRoutingPolicyHash, source.roleRoutingPolicy.policyHash,
  'the routing hash is the routing document own hash');
assert.equal(source.economicPolicyHash, source.economicPolicy.policyHash);
assert.equal(source.pricingCatalogHash, source.pricingCatalog.catalogHash);

// ── Legacy container fields never enter the hashes ──────────────────────────

const legacyEdited = readGovernedPolicySource(containerOf({
  legacy: {
    maxCost: { currency: 'USD', limit: 999_999 },
    maxLatency: { ms: 1 },
    allowedProviders: ['totally', 'different'],
    preferredModel: 'gpt-something-else',
    fallbackProviders: [],
    riskClass: 'elevated',
    triageOnNoRoute: false
  }
}), { role: PLANNER });
assert.equal(legacyEdited.roleRoutingPolicyHash, source.roleRoutingPolicyHash,
  'legacy container edits do not change the routing hash');
assert.equal(legacyEdited.economicPolicyHash, source.economicPolicyHash,
  'legacy container edits do not change the economic hash');
assert.equal(legacyEdited.pricingCatalogHash, source.pricingCatalogHash,
  'legacy container edits do not change the pricing hash');

// maxCost is never converted into monetary authority.
assert.equal(IGNORED_LEGACY_CONTAINER_FIELDS.includes('maxCost'), true,
  'maxCost is explicitly named as ignored');
assert.equal(Object.prototype.hasOwnProperty.call(source.economicPolicy, 'maxCost'), false,
  'the economic policy never carries maxCost');
assert.equal(source.economicPolicy.authorizedMicroUsd, 500_000,
  'the budget comes from the closed document, not from maxCost');

// THE CONTAINER REVISION IS IDENTITY, NEVER CONTENT AUTHORITY.
//
// This assertion previously required that the revision was never read at all.
// That was superseded deliberately: the approved cross-role revision binding
// captures the row's identity so a planner authority and its leaf Runs can be
// proved to come from ONE immutable revision. What must still never happen is
// the revision — or any legacy sibling edit that bumps it — leaking into the
// governed document hashes, which the assertions immediately above prove
// directly by editing legacy fields and re-reading every hash.
const moduleSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'governed-policy-source.js'), 'utf8');
assert.equal(legacyEdited.policyContainerHash, source.policyContainerHash,
  'a legacy container edit does not change the governed content identity');
assert.equal(legacyEdited.economicPolicySetHash, source.economicPolicySetHash,
  'a legacy container edit does not change the economic set identity');
assert.equal(typeof source.policyContainerRevision === 'number' ||
  source.policyContainerRevision === null, true,
'the revision is carried as identity, separate from every document hash');
assert.equal(/inputMicroUsdPerMillionTokens\s*:/.test(moduleSource), false,
  'the module supplies no implicit production pricing');

// ── Missing documents refuse before anything is captured ────────────────────

for (const [omit, expected] of [
  ['roleRoutingPolicy', 'routing_policy_absent'],
  ['economicPolicy', 'economic_policy_absent'],
  ['pricingCatalog', 'pricing_catalog_absent']
]) {
  const container = containerOf();
  delete container.body[GOVERNED_POLICY_KEY][omit];
  assert.equal(
    refusalReason(() => readGovernedPolicySource(container, { role: PLANNER })),
    expected,
    `a missing ${omit} refuses distinctly`);
}

const bare = { body: { name: 'legacy only', maxCost: { limit: 5 } } };
assert.equal(refusalReason(() => readGovernedPolicySource(bare, { role: PLANNER })),
  'governed_policy_absent',
  'a container with only legacy configuration governs nothing');
assert.equal(refusalReason(() => readGovernedPolicySource(null, { role: PLANNER })),
  'governed_policy_absent');

// ── Unknown fields fail closed ──────────────────────────────────────────────

for (const document of GOVERNED_SUBDOCUMENTS) {
  const container = containerOf();
  container.body[GOVERNED_POLICY_KEY][document].surpriseField = 1;
  assert.equal(
    refusalReason(() => readGovernedPolicySource(container, { role: PLANNER })),
    'governed_policy_malformed',
    `an unknown field inside ${document} fails closed`);
}

// A near-miss name is exactly the case that must not be silently dropped.
const nearMiss = containerOf();
delete nearMiss.body[GOVERNED_POLICY_KEY].economicPolicy.maximumOutputTokensPerRequest;
nearMiss.body[GOVERNED_POLICY_KEY].economicPolicy.maxOutputTokens = 2_048;
assert.equal(
  refusalReason(() => readGovernedPolicySource(nearMiss, { role: PLANNER })),
  'governed_policy_malformed',
  'a misspelled field is refused rather than silently ignored');

const extraSub = containerOf();
extraSub.body[GOVERNED_POLICY_KEY].extraPolicy = {};
assert.equal(
  refusalReason(() => readGovernedPolicySource(extraSub, { role: PLANNER })),
  'governed_policy_unknown_subdocument',
  'a fourth subdocument is a configuration error, not an extension point');

for (const document of GOVERNED_SUBDOCUMENTS) {
  const missing = containerOf();
  const field = SUBDOCUMENT_INPUT_FIELDS[document][0];
  delete missing.body[GOVERNED_POLICY_KEY][document][field];
  assert.equal(
    refusalReason(() => readGovernedPolicySource(missing, { role: PLANNER })),
    'governed_policy_malformed',
    `a missing ${document}.${field} fails closed`);
}

// ── The role must be governed by both documents ─────────────────────────────

assert.equal(
  refusalReason(() => readGovernedPolicySource(containerOf(), { role: WORKER })),
  'governed_policy_role_absent',
  'a role the documents do not govern refuses');

const splitRole = containerOf();
splitRole.body[GOVERNED_POLICY_KEY].economicPolicy.role = WORKER;
assert.equal(
  refusalReason(() => readGovernedPolicySource(splitRole, { role: PLANNER })),
  'governed_policy_role_absent',
  'a routed role with no funding refuses before the route is captured');

// ── The economic policy must cite the configured catalog ────────────────────

const mismatched = containerOf();
mismatched.body[GOVERNED_POLICY_KEY].pricingCatalog =
  catalogValue({ outputMicroUsdPerMillionTokens: 1 });
assert.equal(
  refusalReason(() => readGovernedPolicySource(mismatched, { role: PLANNER })),
  'governed_policy_malformed',
  'an economic policy priced by a different catalog refuses');

// ── A container edit applies to FUTURE reads only ───────────────────────────

const before = readGovernedPolicySource(containerOf(), { role: PLANNER });
const after = readGovernedPolicySource(
  containerOf({ catalog: catalogValue({ outputMicroUsdPerMillionTokens: 6_000_000 }) }),
  { role: PLANNER });
assert.notEqual(after.pricingCatalogHash, before.pricingCatalogHash,
  'a re-priced catalog is a different document');
assert.equal(before.pricingCatalogHash, source.pricingCatalogHash,
  'the earlier read is unchanged by the later edit');

console.log('governed policy source test passed');

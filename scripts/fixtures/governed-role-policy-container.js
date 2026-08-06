'use strict';

// One builder for the RAW governed policy container, shared by the contract
// tests, the role-policy suite and the real-server evaluation runner.
//
// WHAT THIS IS AND IS NOT. It builds the container body exactly as an operator
// would store it in `model_routing_policies.body` — raw, unnormalized, closed
// key sets and all. It is NOT a policy source: nothing here bypasses
// `readGovernedPolicySource`, and callers must read the container through
// production to obtain role authority. A fixture that handed a normalized
// source straight to the store is precisely how the missing-capture defect
// survived a full release checkpoint, so this module deliberately cannot do it.
//
// It exists so the runner and the tests cannot drift apart about what a
// correctly configured container looks like.

const { CANONICAL_ROLES } = require('../../runtime/role-routing-contract');
const { buildPricingCatalog } = require('../../runtime/model-pricing-catalog');
// ONE catalog definition, shared with the existing governed fixture and with
// the evaluation's normalized-cost snapshot. Defining a second priced catalog
// here would let the container's economics and the cost method drift apart
// silently, which is exactly the class of divergence this harness exists to
// rule out.
const {
  OPENAI_ADAPTER: ADAPTER_ID,
  EXACT_SNAPSHOT,
  OUTPUT_CAP,
  CAPTURED_AT,
  pricedCatalogValue
} = require('../governed-structured-fixture');

const PROVIDER = 'openai';

function routeEntry(role) {
  return {
    role,
    primaryRoute: { adapterId: ADAPTER_ID, provider: PROVIDER, model: EXACT_SNAPSHOT },
    fallbackRoute: null,
    authorizedFallbackReasons: []
  };
}

// ROLE-SPECIFIC ECONOMIC VALUES, stated per role rather than shared.
//
// The two roles do different work and are bounded differently. A planner issues
// ONE bounded planning request and emits a plan; a leaf executor issues several
// working requests against the same catalog. The request ceilings therefore
// differ on purpose. Where a bound is currently equal for both roles it is
// still written out per role: equal values must never be expressed as one
// shared policy, because that would erase the role identity the reservation and
// settlement paths bind against.
const ROLE_ECONOMICS = Object.freeze({
  structured_planner: Object.freeze({
    authorizedMicroUsd: 500_000,
    // One plan, one bounded planning request.
    maximumProviderRequests: 1,
    maximumOutputTokensPerRequest: OUTPUT_CAP
  }),
  structured_leaf_executor: Object.freeze({
    authorizedMicroUsd: 500_000,
    // Leaf work is iterative and may take several bounded requests.
    maximumProviderRequests: 3,
    maximumOutputTokensPerRequest: OUTPUT_CAP
  })
});

function economicPolicyValue(role, catalog, overrides = {}) {
  const bounds = ROLE_ECONOMICS[role];
  if (!bounds) throw new Error(`no fixture economics for role ${String(role)}`);
  return {
    policyId: `${role}-economics-eval`,
    role,
    authorizedMicroUsd: bounds.authorizedMicroUsd,
    maximumProviderRequests: bounds.maximumProviderRequests,
    maximumOutputTokensPerRequest: bounds.maximumOutputTokensPerRequest,
    pricingCatalogId: catalog.catalogId,
    pricingCatalogHash: catalog.catalogHash,
    fallbackLiabilityAuthorized: false,
    fallbackProviderRequests: 0,
    // Required by the economic-authority contract: a policy that cannot say
    // when it was captured cannot be bound to a request.
    capturedAt: CAPTURED_AT,
    ...overrides
  };
}

// The version-2 governed subdocument: one role-keyed economic set covering
// every role the deployment funds.
function buildGovernedExecutionValue({
  roles = CANONICAL_ROLES,
  economicOverrides = {}
} = {}) {
  const catalogValue = pricedCatalogValue();
  const catalog = buildPricingCatalog(catalogValue);
  return {
    roleRoutingPolicy: {
      policyId: 'eval-routing-1',
      // Routing is SHARED authority: it governs every funded role from the one
      // container, and is hashed separately from the economics.
      rolePolicies: roles.map(routeEntry)
    },
    economicPolicies: roles.map(role => ({
      role,
      policy: economicPolicyValue(role, catalog, economicOverrides[role] || {})
    })),
    pricingCatalog: catalogValue
  };
}

// A full container, shaped as the loader returns it (`{ body }`).
function buildRoleKeyedGovernedContainer(options = {}) {
  return {
    body: {
      // Legacy container siblings, present so fixtures keep proving they are
      // ignored rather than silently converted into authority.
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-ignored',
      governedExecution: buildGovernedExecutionValue(options)
    }
  };
}

// The HISTORICAL version-1 shape: one singular economic policy, funding exactly
// the role it records. Kept so compatibility is proved, never as a target shape.
function buildSingularGovernedContainer({ role = 'structured_planner' } = {}) {
  const value = buildGovernedExecutionValue({ roles: CANONICAL_ROLES });
  const entry = value.economicPolicies.find(candidate => candidate.role === role);
  return {
    body: {
      governedExecution: {
        roleRoutingPolicy: value.roleRoutingPolicy,
        economicPolicy: entry.policy,
        pricingCatalog: value.pricingCatalog
      }
    }
  };
}

module.exports = {
  ADAPTER_ID,
  CAPTURED_AT,
  EXACT_SNAPSHOT,
  PROVIDER,
  ROLE_ECONOMICS,
  buildGovernedExecutionValue,
  buildRoleKeyedGovernedContainer,
  buildSingularGovernedContainer,
  economicPolicyValue,
  pricedCatalogValue,
  routeEntry
};

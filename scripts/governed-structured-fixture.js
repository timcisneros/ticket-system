'use strict';

// Shared test fixture for CURRENT valid governed structured state.
//
// After the Tranche 4 development cutover there is no ungoverned structured
// execution, so every suite that admits a structured leaf Run or advances a
// planning attempt past `created` needs real governed authority. This module
// builds it through the CANONICAL BUILDERS — no hand-written hashes, no
// "legacy structured" mode — so a fixture cannot drift away from what the
// runtime actually accepts.
//
// Suites whose subject is Tranche 3 leaf behaviour rather than economics use
// `zeroPricePolicySource()`, which is a fully valid governed authority whose
// catalog maximum is exactly zero. Every target, routing and authority check
// still applies; only the accounting arithmetic is trivial, which keeps those
// suites focused on their original subject.

const { readGovernedPolicySource } = require('../runtime/governed-policy-source');

const PLANNER_ROLE = 'structured_planner';
const WORKER_ROLE = 'structured_leaf_executor';
const OPENAI_ADAPTER = 'openai.responses.v1';
// An exact dated snapshot. A mutable alias cannot be captured, by design.
const EXACT_SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const GOVERNED_ENDPOINT = 'https://api.openai.com/v1/responses';
const OUTPUT_CAP = 2_048;
const CAPTURED_AT = '2026-08-01T00:00:00.000Z';

// Illustrative fixture rates. NOT production authority.
function pricedCatalogValue(overrides = {}) {
  return {
    catalogId: 'fixture-catalog',
    entries: [{
      provider: 'openai',
      model: EXACT_SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  };
}

// Explicitly zero-priced: eligible because every applicable charge is exactly
// zero, never because a route is assumed free.
function zeroPriceCatalogValue() {
  return {
    catalogId: 'fixture-zero-catalog',
    entries: [{
      provider: 'openai',
      model: EXACT_SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 0,
      outputMicroUsdPerMillionTokens: 0,
      requestMicroUsd: 0,
      boundMethod: 'catalog_maximum_exactly_zero'
    }]
  };
}

function policySource({
  role,
  catalog,
  model = EXACT_SNAPSHOT,
  authorizedMicroUsd = 500_000,
  maximumProviderRequests = 3
}) {
  const built = require('../runtime/model-pricing-catalog').buildPricingCatalog(catalog);
  const container = {
    body: {
      // Legacy container siblings, present so fixtures prove they are ignored.
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-ignored',
      governedExecution: {
        roleRoutingPolicy: {
          policyId: `${role}-routing-1`,
          rolePolicies: [{
            role,
            primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model },
            fallbackRoute: null,
            authorizedFallbackReasons: []
          }]
        },
        economicPolicy: {
          policyId: `${role}-economics-1`,
          role,
          authorizedMicroUsd,
          maximumProviderRequests,
          maximumOutputTokensPerRequest: OUTPUT_CAP,
          pricingCatalogId: built.catalogId,
          pricingCatalogHash: built.catalogHash,
          fallbackLiabilityAuthorized: false,
          fallbackProviderRequests: 0,
          capturedAt: CAPTURED_AT
        },
        pricingCatalog: catalog
      }
    }
  };
  // Both forms: the normalized source production consumes, and the raw
  // container capture reads. A fixture must never feed normalized documents
  // back into a container — the closed key sets would reject them, and rightly.
  const source = readGovernedPolicySource(container, { role });
  return { source, container, role };
}

function workerPolicySource(options = {}) {
  return policySource({
    role: WORKER_ROLE, catalog: pricedCatalogValue(), ...options
  });
}

function plannerPolicySource(options = {}) {
  return policySource({
    role: PLANNER_ROLE, catalog: pricedCatalogValue(), maximumProviderRequests: 1, ...options
  });
}

// For Tranche 3 suites: complete, valid governed authority whose accounting is
// trivially zero so it cannot distract from the subject under test.
function zeroPriceWorkerPolicySource(options = {}) {
  return policySource({
    role: WORKER_ROLE, catalog: zeroPriceCatalogValue(), ...options
  });
}

function zeroPricePlannerPolicySource(options = {}) {
  return policySource({
    role: PLANNER_ROLE, catalog: zeroPriceCatalogValue(), maximumProviderRequests: 1, ...options
  });
}

// The capture a planning attempt needs to become request-capable, and the
// governed block that is attached to it from `request_started` onward.
function capturePlannerFor({ ticketId, planningAttemptId, plannerAgentId, policy }) {
  const {
    capturePlannerGovernance
  } = require('../runtime/structured-planner-governance');
  return capturePlannerGovernance({
    ticketId,
    planningAttemptId,
    plannerAgentId,
    policyContainer: policy.container,
    plannerInput: [{ role: 'user', content: 'Allocate the declared work.' }],
    endpointIdentity: GOVERNED_ENDPOINT,
    capturedAt: new Date().toISOString()
  });
}

// A COMPLETE governed attempt block for PURE CONTRACT suites that have no
// store. Every hash comes from a real capture through the canonical builders;
// only the account and reservation identities are fixture integers, because
// those are database identities a contract test legitimately has none of.
function governedAttemptStateWithoutStore({
  ticketId = 7,
  attemptId = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41',
  plannerAgentId = 1,
  policy = null,
  economicAccountId = 1,
  reservationId = 1,
  economicState = 'request_started',
  settlementReceiptHash = null
} = {}) {
  const {
    buildGovernedExecutionState
  } = require('../runtime/structured-planner-governance');
  const resolved = policy || plannerPolicySource();
  const capture = capturePlannerFor({
    ticketId, planningAttemptId: attemptId, plannerAgentId, policy: resolved
  });
  return buildGovernedExecutionState({
    capture, economicAccountId, reservationId, economicState, settlementReceiptHash
  });
}

// A COMPLETE governed attempt block, produced the way production produces one:
// capture, admit the planner account, reserve the exact request, then build the
// block that binds them. Nothing is hand-written, so a fixture cannot assert a
// shape the runtime would reject.
async function governedAttemptState(store, {
  ticketId, attemptId, plannerAgentId, policy, economicState = 'request_started'
}) {
  const {
    buildGovernedExecutionState
  } = require('../runtime/structured-planner-governance');
  const capture = capturePlannerFor({
    ticketId, planningAttemptId: attemptId, plannerAgentId, policy
  });
  const account = await store.admitTicketEconomicAccount({
    ticketId, role: PLANNER_ROLE, economicPolicy: capture.source.economicPolicy
  });
  const reservation = await store.reserveEconomicRequest({
    preparedRequest: capture.preparedRequest,
    economicAuthority: capture.economicAuthority,
    pricingEntry: capture.pricingEntry
  });
  return {
    capture,
    reservation,
    governedExecution: buildGovernedExecutionState({
      capture,
      economicAccountId: Number(account.account.id),
      reservationId: reservation.id,
      economicState
    })
  };
}

module.exports = {
  governedAttemptState,
  governedAttemptStateWithoutStore,
  CAPTURED_AT,
  EXACT_SNAPSHOT,
  GOVERNED_ENDPOINT,
  OPENAI_ADAPTER,
  OUTPUT_CAP,
  PLANNER_ROLE,
  WORKER_ROLE,
  capturePlannerFor,
  plannerPolicySource,
  pricedCatalogValue,
  workerPolicySource,
  zeroPriceCatalogValue,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource
};

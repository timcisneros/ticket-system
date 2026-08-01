'use strict';

// Tranche 4 — the closed administrator policy source.
//
// THE DISTINCTION THIS MODULE EXISTS TO ENFORCE:
//
//   administrator configuration source  →  CURRENT closed policy documents
//   planning attempt                    →  IMMUTABLE captured copies
//
// The two are not the same authority and must never be confused. An
// administrator may edit configuration at any time; a captured attempt keeps
// the exact normalized documents and hashes it was admitted under, forever.
// This module owns only the first half — reading the current documents — and
// hands back normalized, independently hashed values that a capture step then
// freezes onto an attempt.
//
// THE CONTAINER IS NOT THE AUTHORITY. A `model_routing_policies` row is the
// narrowest existing administrator-owned container, so the three governed
// subdocuments live inside its body. But the row's open JSONB body and its
// `revision` are deliberately NOT authority:
//
//   * the body is open-shaped — normalization spreads unknown keys through, so
//     nothing about the row constrains what may appear in it;
//   * `revision` counts edits to the whole container, including edits to legacy
//     sibling fields that governed execution never reads;
//   * legacy `maxCost` is stored and echoed by the API but enforced NOWHERE,
//     and must never be converted into monetary authority.
//
// So each governed subdocument carries its own version, exact field list,
// normalization and hash, computed over ITSELF ALONE. Unrelated legacy siblings
// in the container cannot enter those hashes, and an unknown field inside a
// governed subdocument fails closed rather than being carried along.

const { deepFreeze } = require('./declared-work-contract');
const { buildRoleRoutingPolicy } = require('./role-routing-contract');
const { buildEconomicPolicy } = require('./economic-authority-contract');
const { buildPricingCatalog } = require('./model-pricing-catalog');

// The single key inside the container body that governed execution reads.
// Everything outside it is legacy container configuration and is ignored.
const GOVERNED_POLICY_KEY = 'governedExecution';

const GOVERNED_POLICY_SOURCE_VERSION = 1;

// Exactly three subdocuments. A fourth is a configuration error, not an
// extension point.
const GOVERNED_SUBDOCUMENTS = Object.freeze([
  'roleRoutingPolicy',
  'economicPolicy',
  'pricingCatalog'
]);

// Legacy container fields that governed execution must never read. Named
// explicitly so that a future edit which starts reading one is a visible change
// rather than a silent reinterpretation.
const IGNORED_LEGACY_CONTAINER_FIELDS = Object.freeze([
  // Ambiguous and unenforced: it has no unit, no scope and no rounding rule.
  // Converting it into a budget would invent authority nobody granted.
  'maxCost',
  'maxLatency',
  'allowedProviders',
  'preferredProvider',
  'preferredModel',
  'fallbackProviders',
  'riskClass',
  'toolRequirements',
  'targetRequirements',
  'verificationRequirement',
  'triageOnNoRoute'
]);

// The exact keys each subdocument may present.
//
// The builders destructure named parameters, so an unknown key would otherwise
// be silently dropped — and a dropped key is the dangerous kind of typo: an
// administrator who writes `maxOutputTokens` instead of
// `maximumOutputTokensPerRequest` would get a policy that governs something
// other than what they wrote, with no error. These lists close that gap before
// any builder runs.
const SUBDOCUMENT_INPUT_FIELDS = Object.freeze({
  roleRoutingPolicy: Object.freeze(['policyId', 'rolePolicies']),
  economicPolicy: Object.freeze([
    'policyId', 'role', 'authorizedMicroUsd', 'maximumProviderRequests',
    'maximumOutputTokensPerRequest', 'pricingCatalogId', 'pricingCatalogHash',
    'fallbackLiabilityAuthorized', 'fallbackProviderRequests', 'capturedAt'
  ]),
  pricingCatalog: Object.freeze(['catalogId', 'entries'])
});

const GOVERNED_POLICY_REFUSALS = Object.freeze([
  'governed_policy_absent',
  'routing_policy_absent',
  'economic_policy_absent',
  'pricing_catalog_absent',
  'governed_policy_malformed',
  'governed_policy_unknown_subdocument',
  'governed_policy_role_absent'
]);

class GovernedPolicySourceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedPolicySourceError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'GOVERNED_POLICY_INVALID', detail = {}) {
  throw new GovernedPolicySourceError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!GOVERNED_POLICY_REFUSALS.includes(reason)) {
    fail(`Unsupported governed policy refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_POLICY_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// ── Reading the current documents ───────────────────────────────────────────
//
// Returns the three normalized documents with independent identities and
// hashes, or refuses. There is no partial success: a container missing any one
// of the three cannot govern execution, because a route without a budget and a
// budget without prices are each unusable on their own.

function readGovernedPolicySource(container, { role }) {
  if (!isPlainObject(container)) {
    refuse('governed_policy_absent', 'no administrator policy container was supplied');
  }
  const body = container.body === undefined ? container : container.body;
  if (!isPlainObject(body)) {
    refuse('governed_policy_malformed', 'the policy container body must be an object');
  }
  const governed = body[GOVERNED_POLICY_KEY];
  if (governed === undefined || governed === null) {
    refuse('governed_policy_absent',
      `the policy container carries no ${GOVERNED_POLICY_KEY} configuration`);
  }
  if (!isPlainObject(governed)) {
    refuse('governed_policy_malformed', `${GOVERNED_POLICY_KEY} must be an object`);
  }

  // Closed at this level too: an unrecognized subdocument is refused rather
  // than ignored, so a misspelled key can never silently disable governance.
  const unknown = Object.keys(governed).filter(key => !GOVERNED_SUBDOCUMENTS.includes(key));
  if (unknown.length > 0) {
    refuse('governed_policy_unknown_subdocument',
      `${GOVERNED_POLICY_KEY} contains unknown subdocument(s): ${unknown.sort().join(', ')}`);
  }

  if (governed.roleRoutingPolicy === undefined || governed.roleRoutingPolicy === null) {
    refuse('routing_policy_absent', 'no role-routing policy is configured');
  }
  if (governed.economicPolicy === undefined || governed.economicPolicy === null) {
    refuse('economic_policy_absent', 'no economic policy is configured');
  }
  if (governed.pricingCatalog === undefined || governed.pricingCatalog === null) {
    // Explicitly separate from the economic policy: a budget with no prices
    // cannot bound anything, and assuming a price would invent authority.
    refuse('pricing_catalog_absent', 'no pricing catalog is configured');
  }

  // Closed key sets first, then the builders. Both are required: the key check
  // catches fields the builders would ignore, and the builders catch values the
  // key check cannot judge.
  for (const name of GOVERNED_SUBDOCUMENTS) {
    const document = governed[name];
    if (!isPlainObject(document)) {
      refuse('governed_policy_malformed', `${name} must be an object`);
    }
    const allowed = SUBDOCUMENT_INPUT_FIELDS[name];
    const extra = Object.keys(document).filter(key => !allowed.includes(key));
    if (extra.length > 0) {
      refuse('governed_policy_malformed',
        `${name} contains unknown field(s): ${extra.sort().join(', ')}`);
    }
    const absent = allowed.filter(
      key => !Object.prototype.hasOwnProperty.call(document, key));
    if (absent.length > 0) {
      refuse('governed_policy_malformed',
        `${name} is missing field(s): ${absent.join(', ')}`);
    }
  }

  // Each document is built by its own contract, which owns its version, field
  // list and hash.
  let roleRoutingPolicy;
  let economicPolicy;
  let pricingCatalog;
  try {
    roleRoutingPolicy = buildRoleRoutingPolicy(governed.roleRoutingPolicy);
  } catch (error) {
    refuse('governed_policy_malformed', `roleRoutingPolicy is invalid: ${error.message}`);
  }
  try {
    pricingCatalog = buildPricingCatalog(governed.pricingCatalog);
  } catch (error) {
    refuse('governed_policy_malformed', `pricingCatalog is invalid: ${error.message}`);
  }
  try {
    economicPolicy = buildEconomicPolicy(governed.economicPolicy);
  } catch (error) {
    refuse('governed_policy_malformed', `economicPolicy is invalid: ${error.message}`);
  }

  // The role must actually be governed by BOTH documents. A routing policy that
  // authorizes a role the economic policy does not fund would reach the point
  // of reservation and refuse there, after the route was already captured.
  if (!roleRoutingPolicy.rolePolicies.some(entry => entry.role === role)) {
    refuse('governed_policy_role_absent',
      `the role-routing policy does not govern ${String(role)}`);
  }
  if (economicPolicy.role !== role) {
    refuse('governed_policy_role_absent',
      `the economic policy governs ${economicPolicy.role}, not ${String(role)}`);
  }
  // The economic policy must be priced by THIS catalog, or the ceilings it
  // states were computed against prices nobody supplied.
  if (economicPolicy.pricingCatalogId !== pricingCatalog.catalogId ||
      economicPolicy.pricingCatalogHash !== pricingCatalog.catalogHash) {
    refuse('governed_policy_malformed',
      'the economic policy does not cite the configured pricing catalog');
  }

  return deepFreeze({
    version: GOVERNED_POLICY_SOURCE_VERSION,
    role,
    // Three independent identities and three independent hashes. None of them
    // covers the container, its revision, or any legacy sibling field.
    roleRoutingPolicy,
    roleRoutingPolicyHash: roleRoutingPolicy.policyHash,
    economicPolicy,
    economicPolicyHash: economicPolicy.policyHash,
    pricingCatalog,
    pricingCatalogHash: pricingCatalog.catalogHash
  });
}

module.exports = {
  GOVERNED_POLICY_KEY,
  GOVERNED_POLICY_REFUSALS,
  GOVERNED_POLICY_SOURCE_VERSION,
  GOVERNED_SUBDOCUMENTS,
  GovernedPolicySourceError,
  IGNORED_LEGACY_CONTAINER_FIELDS,
  SUBDOCUMENT_INPUT_FIELDS,
  readGovernedPolicySource,
  refuseGovernedPolicy: refuse
};

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

const { deepFreeze, hashCanonical } = require('./declared-work-contract');
const { CANONICAL_ROLES, buildRoleRoutingPolicy } = require('./role-routing-contract');
const { buildEconomicPolicy } = require('./economic-authority-contract');
const { buildPricingCatalog } = require('./model-pricing-catalog');

// The single key inside the container body that governed execution reads.
// Everything outside it is legacy container configuration and is ignored.
const GOVERNED_POLICY_KEY = 'governedExecution';

const GOVERNED_POLICY_SOURCE_VERSION = 2;

// Exactly three AUTHORITY CATEGORIES. A fourth is a configuration error, not an
// extension point.
const GOVERNED_SUBDOCUMENTS = Object.freeze([
  'roleRoutingPolicy',
  'economicPolicy',
  'pricingCatalog'
]);

// ── The economic authority category has two versioned shapes ────────────────
//
// ONE CONTAINER, ONE ECONOMIC CATEGORY, TWO REPRESENTATIONS. `economicPolicies`
// is NOT a fourth subdocument: it is the version-2 shape of the SAME economic
// authority category that `economicPolicy` expresses at version 1. Exactly one
// of the two may appear. Declaring both is refused rather than resolved,
// because a container that states its economics twice has no single answer to
// "what funds this role".
//
// WHY THE SHAPE HAD TO CHANGE. A singular `economicPolicy` records exactly one
// role. The structured path needs two — a planner that plans and a leaf
// executor that works — and only ONE active governed container is permitted.
// So a singular container could fund the planner or the worker, never both, and
// the structured plan-to-leaf path could not be configured at all.
const ECONOMIC_AUTHORITY_KEYS = Object.freeze({
  1: 'economicPolicy',
  2: 'economicPolicies'
});

const ECONOMIC_SET_VERSIONS = Object.freeze([1, 2]);

// Every key the governed subdocument may present. Both economic shapes appear
// so that the WRONG-SHAPE case is a shape refusal rather than an "unknown
// subdocument" one — the two failures mean different things to an operator.
const GOVERNED_CONTAINER_KEYS = Object.freeze([
  'roleRoutingPolicy',
  'economicPolicy',
  'economicPolicies',
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

// A version-2 economic entry states its role as an explicit KEY beside the
// policy, so that a policy whose embedded role disagrees with the role it is
// filed under is a detectable contradiction rather than a silent reinterpretation.
const ECONOMIC_SET_ENTRY_FIELDS = Object.freeze(['role', 'policy']);

const GOVERNED_POLICY_REFUSALS = Object.freeze([
  'governed_policy_absent',
  'routing_policy_absent',
  'economic_policy_absent',
  'pricing_catalog_absent',
  'governed_policy_malformed',
  'governed_policy_unknown_subdocument',
  'governed_policy_role_absent',
  // The economic category is declared twice, or not in a single usable shape.
  'governed_policy_economic_shape_ambiguous',
  // The role-keyed set itself is unusable: empty, duplicated, non-canonical, or
  // filed under a role its policy does not claim.
  'governed_policy_economic_set_malformed'
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

// ── The role-keyed economic policy set ──────────────────────────────────────
//
// Normalization produces the SAME sealed shape for both container versions:
//
//   { version, entries: [ { role, policy, policyHash } ... ], setHash }
//
// `entries` is ordered by `CANONICAL_ROLES`, never by input order, so two
// containers that fund the same roles with the same policies hash identically
// however an operator happened to write them. `setHash` covers the version and
// every (role, policyHash) pair, so changing EITHER role's policy changes it,
// and it is identical no matter which role is later selected.

function assertClosedEconomicDocument(document, label) {
  if (!isPlainObject(document)) {
    refuse('governed_policy_malformed', `${label} must be an object`);
  }
  const allowed = SUBDOCUMENT_INPUT_FIELDS.economicPolicy;
  const extra = Object.keys(document).filter(key => !allowed.includes(key));
  if (extra.length > 0) {
    refuse('governed_policy_malformed',
      `${label} contains unknown field(s): ${extra.sort().join(', ')}`);
  }
  const absent = allowed.filter(
    key => !Object.prototype.hasOwnProperty.call(document, key));
  if (absent.length > 0) {
    refuse('governed_policy_malformed',
      `${label} is missing field(s): ${absent.join(', ')}`);
  }
}

function buildEconomicEntry(document, label) {
  try {
    return buildEconomicPolicy(document);
  } catch (error) {
    refuse('governed_policy_malformed', `${label} is invalid: ${error.message}`);
    return null; // unreachable; `refuse` throws.
  }
}

function sealEconomicPolicySet(version, policies) {
  if (!ECONOMIC_SET_VERSIONS.includes(version)) {
    fail(`unsupported economic policy set version ${String(version)}`);
  }
  // Canonical order, imposed here rather than trusted from the container.
  const ordered = CANONICAL_ROLES
    .map(role => policies.find(policy => policy.role === role))
    .filter(Boolean);
  if (ordered.length !== policies.length) {
    fail('an economic policy escaped canonical role ordering');
  }
  const entries = ordered.map(policy => deepFreeze({
    role: policy.role,
    policy,
    // Each entry keeps its OWN identity, independently verifiable against the
    // policy it names.
    policyHash: policy.policyHash
  }));
  return deepFreeze({
    version,
    entries,
    roles: Object.freeze(entries.map(entry => entry.role)),
    setHash: hashCanonical({
      version,
      entries: entries.map(entry => ({ role: entry.role, policyHash: entry.policyHash }))
    })
  });
}

// Version 1: one policy, funding exactly the role it records. It remains
// readable forever, and is never reinterpreted as funding a second role.
function normalizeSingularEconomicAuthority(document) {
  assertClosedEconomicDocument(document, 'economicPolicy');
  return sealEconomicPolicySet(1,
    [buildEconomicEntry(document, 'economicPolicy')]);
}

// Version 2: a closed, role-keyed set.
function normalizeRoleKeyedEconomicAuthority(value) {
  if (!Array.isArray(value)) {
    refuse('governed_policy_economic_set_malformed',
      'economicPolicies must be a list of { role, policy } entries');
  }
  if (value.length === 0) {
    refuse('governed_policy_economic_set_malformed',
      'economicPolicies is empty; a container that funds no role cannot govern execution');
  }
  const policies = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const label = `economicPolicies[${index}]`;
    if (!isPlainObject(entry)) {
      refuse('governed_policy_economic_set_malformed', `${label} must be an object`);
    }
    const extra = Object.keys(entry).filter(key => !ECONOMIC_SET_ENTRY_FIELDS.includes(key));
    if (extra.length > 0) {
      refuse('governed_policy_economic_set_malformed',
        `${label} contains unknown field(s): ${extra.sort().join(', ')}`);
    }
    const absent = ECONOMIC_SET_ENTRY_FIELDS.filter(
      key => !Object.prototype.hasOwnProperty.call(entry, key));
    if (absent.length > 0) {
      refuse('governed_policy_economic_set_malformed',
        `${label} is missing field(s): ${absent.join(', ')}`);
    }
    if (!CANONICAL_ROLES.includes(entry.role)) {
      refuse('governed_policy_economic_set_malformed',
        `${label} names ${String(entry.role)}, which is not a canonical execution role`);
    }
    // At most one entry per role. Two entries for one role would make "the
    // policy that funds this role" ambiguous, and picking either would be a
    // guess.
    if (seen.has(entry.role)) {
      refuse('governed_policy_economic_set_malformed',
        `economicPolicies declares ${entry.role} more than once`);
    }
    seen.add(entry.role);
    assertClosedEconomicDocument(entry.policy, `${label}.policy`);
    // The key and the policy must agree. A policy filed under the planner but
    // claiming the worker role would otherwise fund the wrong role under the
    // right name.
    if (entry.policy.role !== entry.role) {
      refuse('governed_policy_economic_set_malformed',
        `${label} is filed under ${entry.role} but its policy governs ` +
        `${String(entry.policy.role)}`);
    }
    policies.push(buildEconomicEntry(entry.policy, `${label}.policy`));
  }
  return sealEconomicPolicySet(2, policies);
}

function normalizeEconomicPolicySet(governed) {
  const declared = ECONOMIC_SET_VERSIONS
    .map(version => ECONOMIC_AUTHORITY_KEYS[version])
    .filter(key => governed[key] !== undefined && governed[key] !== null);
  if (declared.length === 0) {
    refuse('economic_policy_absent', 'no economic policy is configured');
  }
  if (declared.length > 1) {
    refuse('governed_policy_economic_shape_ambiguous',
      'the container declares both a singular economicPolicy and a role-keyed ' +
      'economicPolicies set; exactly one economic authority shape is permitted');
  }
  return declared[0] === ECONOMIC_AUTHORITY_KEYS[1]
    ? normalizeSingularEconomicAuthority(governed.economicPolicy)
    : normalizeRoleKeyedEconomicAuthority(governed.economicPolicies);
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
  const unknown = Object.keys(governed).filter(key => !GOVERNED_CONTAINER_KEYS.includes(key));
  if (unknown.length > 0) {
    refuse('governed_policy_unknown_subdocument',
      `${GOVERNED_POLICY_KEY} contains unknown subdocument(s): ${unknown.sort().join(', ')}`);
  }

  if (governed.roleRoutingPolicy === undefined || governed.roleRoutingPolicy === null) {
    refuse('routing_policy_absent', 'no role-routing policy is configured');
  }
  if (governed.pricingCatalog === undefined || governed.pricingCatalog === null) {
    // Explicitly separate from the economic policy: a budget with no prices
    // cannot bound anything, and assuming a price would invent authority.
    refuse('pricing_catalog_absent', 'no pricing catalog is configured');
  }

  // Closed key sets first, then the builders. Both are required: the key check
  // catches fields the builders would ignore, and the builders catch values the
  // key check cannot judge.
  for (const name of ['roleRoutingPolicy', 'pricingCatalog']) {
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
  // The whole economic set is normalized before any role is selected, so a
  // malformed sibling entry refuses the container rather than being skipped
  // because the caller happened to ask for the other role.
  const economicPolicySet = normalizeEconomicPolicySet(governed);

  // The role must actually be governed by BOTH authorities. A routing policy
  // that authorizes a role the economic set does not fund would reach the point
  // of reservation and refuse there, after the route was already captured.
  if (!roleRoutingPolicy.rolePolicies.some(entry => entry.role === role)) {
    refuse('governed_policy_role_absent',
      `the role-routing policy does not govern ${String(role)}`);
  }
  // EXACT SELECTION, NEVER A FALLBACK. There is no "first entry", no default to
  // the planner, and no inference from the caller. A container that does not
  // fund the requested role fails closed — including a historical singular
  // container, which funds exactly the one role it recorded and never lends it
  // to another.
  const selected = economicPolicySet.entries.find(entry => entry.role === role);
  if (!selected) {
    refuse('governed_policy_role_absent',
      `governed role economic policy unavailable: the container funds ` +
      `${economicPolicySet.roles.join(', ') || 'no role'}, not ${String(role)}`);
  }
  // EVERY entry must be priced by THIS catalog, or a ceiling it states was
  // computed against prices nobody supplied. Checked across the whole set, not
  // just the selected role, because the catalog is shared authority.
  for (const entry of economicPolicySet.entries) {
    if (entry.policy.pricingCatalogId !== pricingCatalog.catalogId ||
        entry.policy.pricingCatalogHash !== pricingCatalog.catalogHash) {
      refuse('governed_policy_malformed',
        `the ${entry.role} economic policy does not cite the configured pricing catalog`);
    }
  }

  return deepFreeze({
    version: GOVERNED_POLICY_SOURCE_VERSION,
    role,
    // Independent identities and independent hashes. None of them covers the
    // container row, its revision, or any legacy sibling field.
    //
    // SHARED authority — identical for every role read from this container:
    roleRoutingPolicy,
    roleRoutingPolicyHash: roleRoutingPolicy.policyHash,
    pricingCatalog,
    pricingCatalogHash: pricingCatalog.catalogHash,
    // The ENTIRE funded set, so the parent economic identity a Run captures is
    // the same whichever role was selected. Selecting a role reads the
    // container; it never changes it.
    economicPolicySetVersion: economicPolicySet.version,
    economicPolicySetHash: economicPolicySet.setHash,
    economicPolicyRoles: economicPolicySet.roles,
    // SELECTED authority — the exact policy funding the requested role:
    economicPolicy: selected.policy,
    economicPolicyHash: selected.policyHash
  });
}

module.exports = {
  ECONOMIC_AUTHORITY_KEYS,
  ECONOMIC_SET_ENTRY_FIELDS,
  ECONOMIC_SET_VERSIONS,
  GOVERNED_CONTAINER_KEYS,
  GOVERNED_POLICY_KEY,
  GOVERNED_POLICY_REFUSALS,
  GOVERNED_POLICY_SOURCE_VERSION,
  GOVERNED_SUBDOCUMENTS,
  GovernedPolicySourceError,
  IGNORED_LEGACY_CONTAINER_FIELDS,
  SUBDOCUMENT_INPUT_FIELDS,
  normalizeEconomicPolicySet,
  readGovernedPolicySource,
  refuseGovernedPolicy: refuse
};

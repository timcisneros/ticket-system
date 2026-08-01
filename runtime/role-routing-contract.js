'use strict';

// Tranche 4 — canonical execution roles and deterministic role-aware routing.
//
// This module answers one question and only one: WHICH admitted route may
// perform this role for this work? It selects nothing by preference, price,
// latency or availability, contacts no provider, and reads no live agent row.
// A decision is a pure function of an admitted policy plus already-captured work
// authority, so the same inputs always produce the same decision hash.
//
// It is not a marketplace, not a load balancer, and not a fallback chain. There
// is exactly one primary route per role, exactly one optionally-authorized
// alternative, and refusal. "Available", "cheaper" and "the default provider"
// are not reasons to route anywhere.
//
// AUTHORITY FLOWS ONE WAY:
//
//   routing decision  ──consumed by──▶  economic authority
//
// The economic authority binds `routingDecisionHash`. The routing decision binds
// nothing economic in return — not even an economic-policy identifier. A
// reciprocal reference would make the two hashes mutually dependent, so changing
// a budget would perturb a route hash that did not change, and re-pricing work
// would look like re-routing it. Nothing in the runtime needs routing to name
// its economic companion: every consumer already holds both.
//
// ROUTING IS NOT ECONOMICS. This module deliberately imports no pricing catalog,
// no model capability, no economic authority and no account persistence. A route
// may be authorized for a role while being economically inadmissible — an
// arbitrary local model with no token-bound proof is exactly that case — and
// deciding admissibility is the economic-authority contract's job, not this
// one's. Collapsing the two would make "which route may do this work" fail
// merely because "what may it cost" is unknown.
//
// A routing decision therefore NEVER authorizes provider contact by itself.
// Governed dispatch requires a valid captured routing decision AND a valid
// captured economic authority AND a committed reservation.
//
// AUTHORIZATION IS NOT CAPTURE. A policy may authorize a model REFERENCE that is
// not an execution target — a mutable alias, or a tag whose artifact can be
// replaced. Such a reference stays representable in policy, but a governed
// decision cannot be captured from it: the decision would look immutable while
// executing something else later. Capture therefore binds an immutable dispatch
// target, and refuses `route_target_not_immutable` when none exists. That is a
// ROUTING refusal — economics is never consulted for a route that cannot even
// be captured.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  assertDispatchTargetUnchanged,
  resolveImmutableDispatchTarget
} = require('./execution-target-registry');
const ROLE_ROUTING_DECISION_VERSION = 1;
const ROLE_ROUTING_POLICY_VERSION = 1;

// The only roles this tranche admits. Each already exists as durable runtime
// authority: the designated planner captured in the planning-authority snapshot,
// and the assigned worker named by an immutable allocation item. A role is
// dispatch context — it is not an agent identity and not a product primitive.
//
// No verifier, critic, reviewer, manager, supervisor or recursive-delegator role
// appears here, because none exists as durable authority in this repository.
const CANONICAL_ROLES = Object.freeze([
  'structured_planner',
  'structured_leaf_executor'
]);

// Ordinary historical execution has NO role. That is deliberate: a null role
// means "ungoverned", and every pre-Tranche-4 path keeps its existing behavior.
const UNGOVERNED_ROLE = null;

const ROUTE_SELECTION_REASONS = Object.freeze([
  'role_authorized_primary',
  'role_authorized_fallback'
]);

// Closed grounds on which a policy may authorize its alternative route. A
// free-form string is not a reason, and "cheaper", "faster" and "busy" are
// deliberately absent — this tranche adds no optimization and no availability
// bidding.
const FALLBACK_REASONS = Object.freeze([
  'primary_route_provider_unavailable',
  'primary_route_model_withdrawn'
]);

const ROUTING_REFUSALS = Object.freeze([
  'unknown_role',
  'role_not_configured',
  'no_eligible_role_route',
  'route_not_authorized_for_role',
  'fallback_not_authorized',
  'fallback_reason_not_authorized',
  'fallback_reason_malformed',
  'fallback_preflight_evidence_unavailable',
  'route_target_not_immutable',
  'route_target_drift',
  'model_snapshot_not_admitted',
  'acting_agent_mismatch',
  'routing_policy_malformed',
  'routing_decision_conflict'
]);

// A route names its adapter, provider and exact model. All three are authored by
// the policy; none is resolved against an economic capability. `routeId` is
// derived purely from those three, so a normalized route is accepted back as
// input and re-derives identically.
const ROUTE_FIELDS = Object.freeze(['adapterId', 'provider', 'model']);
const ROUTE_DERIVED_FIELDS = Object.freeze(['routeId']);

// ROUTING fields only. `budgetMicroUsd`, output caps and request limits are
// ECONOMIC policy: they may be stored in the same administrator row, but they
// live in a separate closed sub-authority with its own hash, are consumed only
// by the economic-authority contract, and never participate in route selection.
// Changing a budget must not change the routing-policy hash.
const ROLE_POLICY_FIELDS = Object.freeze([
  'role',
  'primaryRoute',
  // Explicitly authorized alternative, or null. There is no chain: one named
  // alternative or nothing.
  'fallbackRoute',
  // Which closed reasons this policy authorizes as grounds for the alternative.
  // Empty means the alternative may never be selected, whatever a caller claims.
  'authorizedFallbackReasons'
]);

const ROUTING_POLICY_FIELDS = Object.freeze([
  'version',
  'policyId',
  'rolePolicies',
  'policyHash'
]);

const ROUTING_DECISION_FIELDS = Object.freeze([
  'version',
  'routingPolicyId',
  'routingPolicyHash',
  'role',
  'ticketId',
  'subjectKind',
  'subjectId',
  'allocationPlanId',
  'allocationItemId',
  'actingAgentId',
  'adapterId',
  'provider',
  // What policy authorized. May be an alias or a tag.
  'routeReference',
  // What will actually execute. Immutable, and covered by the decision hash.
  'dispatchTarget',
  'targetKind',
  'targetEvidenceIdentity',
  'targetEvidenceHash',
  'primaryRouteId',
  'fallbackRouteId',
  'selectionReason',
  'fallbackAuthorized',
  'fallbackUsed',
  'fallbackReason',
  'decidedAt',
  'decisionHash'
]);

// A governed decision belongs to exactly one subject: the planning attempt that
// will issue the planner request, or the Run that will issue worker requests.
const SUBJECT_KINDS = Object.freeze(['planning_attempt', 'run']);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class RoleRoutingError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'RoleRoutingError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'ROLE_ROUTING_INVALID', detail = {}) {
  throw new RoleRoutingError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!ROUTING_REFUSALS.includes(reason)) {
    fail(`Unsupported routing refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'ROLE_ROUTING_REFUSED', { reason });
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

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nullablePositiveSafeInteger(value, label) {
  return value === null ? null : positiveSafeInteger(value, label);
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

function timestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function enumerated(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is unsupported: ${String(value)}`);
  return value;
}

function assertCanonicalRole(role) {
  if (!CANONICAL_ROLES.includes(role)) {
    refuse('unknown_role', `${String(role)} is not a canonical execution role`);
  }
  return role;
}

// ── Routing policy ──────────────────────────────────────────────────────────
//
// A route names a provider and an EXACT model snapshot. Both must resolve to an
// admitted runtime model capability, so a policy cannot authorize a model whose
// limits the runtime does not know — that is what stops a route from being
// authorized while being unbounded.

function normalizeRoute(value, label) {
  if (value === null) return null;
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const authored = Object.fromEntries(Object.entries(value)
    .filter(([field]) => !ROUTE_DERIVED_FIELDS.includes(field)));
  exactFields(authored, ROUTE_FIELDS, label);
  const adapterId = requiredText(value.adapterId, `${label}.adapterId`, 128);
  const provider = requiredText(value.provider, `${label}.provider`, 64);
  const model = requiredText(value.model, `${label}.model`, 256);
  // Deliberately NO capability, pricing or budget lookup. A policy may authorize
  // a model whose economic capability is unknown; the economic-authority
  // contract refuses the dispatch later, and refuses it for economic reasons
  // with economic reason codes.
  return deepFreeze({
    adapterId,
    provider,
    model,
    routeId: `${adapterId}|${provider}|${model}`
  });
}

function normalizeRolePolicy(value, index) {
  const label = `roleRoutingPolicy.rolePolicies[${index}]`;
  exactFields(value, ROLE_POLICY_FIELDS, label);
  const role = assertCanonicalRole(value.role);
  const primaryRoute = normalizeRoute(value.primaryRoute, `${label}.primaryRoute`);
  if (primaryRoute === null) {
    refuse('role_not_configured', `${label} declares no primary route`);
  }
  const fallbackRoute = normalizeRoute(value.fallbackRoute, `${label}.fallbackRoute`);
  // A fallback identical to the primary is not a fallback; it is a duplicate
  // that would make `fallbackUsed` meaningless.
  if (fallbackRoute !== null && fallbackRoute.routeId === primaryRoute.routeId) {
    fail(`${label}.fallbackRoute duplicates its primary route`);
  }
  if (!Array.isArray(value.authorizedFallbackReasons)) {
    fail(`${label}.authorizedFallbackReasons must be an array`);
  }
  const authorizedFallbackReasons = [...value.authorizedFallbackReasons]
    .map(reason => enumerated(reason, FALLBACK_REASONS, `${label}.authorizedFallbackReasons`))
    .sort(compareCanonicalText);
  if (new Set(authorizedFallbackReasons).size !== authorizedFallbackReasons.length) {
    fail(`${label}.authorizedFallbackReasons must not repeat a reason`);
  }
  if (fallbackRoute === null && authorizedFallbackReasons.length > 0) {
    fail(`${label} authorizes fallback reasons but declares no fallback route`);
  }
  return { role, primaryRoute, fallbackRoute, authorizedFallbackReasons };
}

function buildRoleRoutingPolicy({ policyId, rolePolicies }) {
  if (!Array.isArray(rolePolicies) || rolePolicies.length === 0) {
    refuse('routing_policy_malformed', 'roleRoutingPolicy.rolePolicies must be non-empty');
  }
  const normalized = rolePolicies
    .map(normalizeRolePolicy)
    .sort((left, right) => compareCanonicalText(left.role, right.role));
  const roles = normalized.map(policy => policy.role);
  if (new Set(roles).size !== roles.length) {
    refuse('routing_policy_malformed', 'each role may be configured at most once');
  }
  const withoutHash = {
    version: ROLE_ROUTING_POLICY_VERSION,
    policyId: requiredText(policyId, 'roleRoutingPolicy.policyId', 128),
    rolePolicies: normalized
  };
  return deepFreeze({ ...withoutHash, policyHash: hashCanonical(withoutHash) });
}

function normalizeRoleRoutingPolicy(value) {
  exactFields(value, ROUTING_POLICY_FIELDS, 'roleRoutingPolicy');
  if (value.version !== ROLE_ROUTING_POLICY_VERSION) {
    fail(`roleRoutingPolicy.version must be ${ROLE_ROUTING_POLICY_VERSION}`);
  }
  const rebuilt = buildRoleRoutingPolicy(value);
  if (hash(value.policyHash, 'roleRoutingPolicy.policyHash') !== rebuilt.policyHash) {
    fail('roleRoutingPolicy.policyHash does not match its admitted routes');
  }
  return rebuilt;
}

function rolePolicyFor(policy, role) {
  assertCanonicalRole(role);
  const rolePolicy = policy.rolePolicies.find(candidate => candidate.role === role) || null;
  if (!rolePolicy) {
    refuse('role_not_configured', `routing policy ${policy.policyId} configures no ${role} route`);
  }
  return rolePolicy;
}

// ── Route selection ─────────────────────────────────────────────────────────
//
// Precedence is singular and total:
//
//   exact role-authorized primary route
//   → exact explicitly authorized fallback
//   → refusal
//
// `requirePrimaryUnavailableReason` exists so a fallback can never be taken
// silently: a caller must state WHY the primary was not used, and the reason is
// recorded on the decision.

// `preflightEvidence` is the ONLY way to reach the alternative route, and it is
// a closed runtime-produced structure, never a caller-supplied string. A model,
// API payload, UI field or mutable agent object cannot force a fallback by
// asserting one.
//
// No canonical availability/preflight evidence seam exists in this repository
// yet, so fallback authorization is fully REPRESENTABLE in policy and in the
// decision schema, but selection always refuses
// `fallback_preflight_evidence_unavailable`. Manufacturing an availability
// authority here would invent exactly the runtime fact this tranche must not
// invent. When a canonical seam lands, this is the one function that changes.
const FALLBACK_EVIDENCE_FIELDS = Object.freeze(['reason', 'primaryRouteId', 'evidenceHash']);

function selectRoleRoute(policy, role, { preflightEvidence = null } = {}) {
  const rolePolicy = rolePolicyFor(policy, role);
  if (preflightEvidence === null) {
    return {
      route: rolePolicy.primaryRoute,
      reason: 'role_authorized_primary',
      fallbackUsed: false,
      fallbackReason: null
    };
  }
  // Shape first: a string, or anything but the closed structure, is malformed.
  if (!isPlainObject(preflightEvidence)) {
    refuse('fallback_reason_malformed',
      'fallback requires closed preflight evidence, not a caller-supplied reason');
  }
  exactFields(preflightEvidence, FALLBACK_EVIDENCE_FIELDS, 'preflightEvidence');
  const reason = preflightEvidence.reason;
  if (!FALLBACK_REASONS.includes(reason)) {
    refuse('fallback_reason_malformed', `${String(reason)} is not a closed fallback reason`);
  }
  if (rolePolicy.fallbackRoute === null) {
    // No silent substitution: with no authorized alternative the role refuses.
    refuse('fallback_not_authorized',
      `routing policy ${policy.policyId} authorizes no ${role} fallback`);
  }
  if (!rolePolicy.authorizedFallbackReasons.includes(reason)) {
    refuse('fallback_reason_not_authorized',
      `routing policy ${policy.policyId} does not authorize ${reason} for ${role}`);
  }
  // The evidence must be about THIS role's primary route, so evidence gathered
  // for one role or route cannot authorize another's substitution.
  if (preflightEvidence.primaryRouteId !== rolePolicy.primaryRoute.routeId) {
    refuse('fallback_reason_not_authorized',
      `preflight evidence describes ${preflightEvidence.primaryRouteId}, ` +
      `not ${rolePolicy.primaryRoute.routeId}`);
  }
  // Nothing in this repository can produce trustworthy availability evidence, so
  // there is no hash to verify it against and selection stops here.
  refuse('fallback_preflight_evidence_unavailable',
    'no canonical preflight-evidence seam exists, so fallback cannot be selected');
}

// ── Immutable routing decision ──────────────────────────────────────────────

function buildRoleRoutingDecision({
  policy,
  role,
  ticketId,
  subjectKind,
  subjectId,
  allocationPlanId = null,
  allocationItemId = null,
  actingAgentId,
  decidedAt,
  preflightEvidence = null
}) {
  const normalizedPolicy = Object.prototype.hasOwnProperty.call(policy, 'policyHash')
    ? policy
    : buildRoleRoutingPolicy(policy);
  const canonicalRole = assertCanonicalRole(role);
  const rolePolicy = rolePolicyFor(normalizedPolicy, canonicalRole);
  const selection = selectRoleRoute(normalizedPolicy, canonicalRole, { preflightEvidence });
  // Capture gate. A fallback route is held to exactly the same standard as a
  // primary: it cannot bypass immutable-target validation.
  let immutableTarget;
  try {
    immutableTarget = resolveImmutableDispatchTarget({
      adapterId: selection.route.adapterId,
      provider: selection.route.provider,
      model: selection.route.model
    });
  } catch (error) {
    refuse('route_target_not_immutable',
      error.message || `${selection.route.model} is not an immutable execution target`);
  }
  const kind = enumerated(subjectKind, SUBJECT_KINDS, 'routingDecision.subjectKind');
  // A planning attempt is identified by UUID; a Run by its integer identity.
  const identity = kind === 'planning_attempt'
    ? (UUID_PATTERN.test(String(subjectId))
      ? String(subjectId)
      : fail('routingDecision.subjectId must be a lowercase UUID for a planning attempt'))
    : positiveSafeInteger(subjectId, 'routingDecision.subjectId');

  const withoutHash = {
    version: ROLE_ROUTING_DECISION_VERSION,
    routingPolicyId: normalizedPolicy.policyId,
    routingPolicyHash: normalizedPolicy.policyHash,
    role: canonicalRole,
    ticketId: positiveSafeInteger(ticketId, 'routingDecision.ticketId'),
    subjectKind: kind,
    subjectId: identity,
    allocationPlanId: nullablePositiveSafeInteger(
      allocationPlanId,
      'routingDecision.allocationPlanId'
    ),
    allocationItemId: nullablePositiveSafeInteger(
      allocationItemId,
      'routingDecision.allocationItemId'
    ),
    actingAgentId: positiveSafeInteger(actingAgentId, 'routingDecision.actingAgentId'),
    adapterId: selection.route.adapterId,
    provider: selection.route.provider,
    routeReference: selection.route.model,
    dispatchTarget: immutableTarget.dispatchTarget,
    targetKind: immutableTarget.targetKind,
    targetEvidenceIdentity: immutableTarget.targetEvidenceIdentity,
    targetEvidenceHash: immutableTarget.targetEvidenceHash,
    primaryRouteId: rolePolicy.primaryRoute.routeId,
    fallbackRouteId: rolePolicy.fallbackRoute === null
      ? null
      : rolePolicy.fallbackRoute.routeId,
    selectionReason: enumerated(
      selection.reason,
      ROUTE_SELECTION_REASONS,
      'routingDecision.selectionReason'
    ),
    // Whether the policy authorizes any alternative at all, recorded separately
    // from whether one was taken.
    fallbackAuthorized: rolePolicy.fallbackRoute !== null,
    fallbackUsed: selection.fallbackUsed,
    fallbackReason: selection.fallbackReason,
    decidedAt: timestamp(decidedAt, 'routingDecision.decidedAt')
  };
  return deepFreeze({ ...withoutHash, decisionHash: hashCanonical(withoutHash) });
}

function normalizeRoleRoutingDecision(value, {
  expectedRole = null,
  expectedTicketId = null,
  expectedSubjectId = null,
  expectedPolicyHash = null
} = {}) {
  exactFields(value, ROUTING_DECISION_FIELDS, 'routingDecision');
  if (value.version !== ROLE_ROUTING_DECISION_VERSION) {
    fail(`routingDecision.version must be ${ROLE_ROUTING_DECISION_VERSION}`);
  }
  const decisionHash = hash(value.decisionHash, 'routingDecision.decisionHash');
  const withoutHash = Object.fromEntries(
    ROUTING_DECISION_FIELDS.filter(field => field !== 'decisionHash')
      .map(field => [field, value[field]])
  );
  if (hashCanonical(withoutHash) !== decisionHash) {
    fail('routingDecision.decisionHash does not match its captured route',
      'ROLE_ROUTING_DECISION_CONFLICT');
  }
  assertCanonicalRole(value.role);
  enumerated(value.subjectKind, SUBJECT_KINDS, 'routingDecision.subjectKind');
  enumerated(value.selectionReason, ROUTE_SELECTION_REASONS, 'routingDecision.selectionReason');
  if (value.fallbackUsed && !value.fallbackAuthorized) {
    refuse('fallback_not_authorized',
      'routingDecision records a fallback its policy never authorized');
  }
  if (value.fallbackUsed !== (value.selectionReason === 'role_authorized_fallback')) {
    fail('routingDecision.fallbackUsed disagrees with its selection reason');
  }
  const expectations = [
    ['role', expectedRole, 'does not identify its role'],
    ['ticketId', expectedTicketId, 'does not identify its ticket'],
    ['subjectId', expectedSubjectId, 'does not identify its subject'],
    ['routingPolicyHash', expectedPolicyHash, 'does not identify its policy']
  ];
  for (const [field, expected, message] of expectations) {
    if (expected === null) continue;
    if (value[field] !== expected) {
      refuse('routing_decision_conflict', `routingDecision.${field} ${message}`);
    }
  }
  return deepFreeze({ ...withoutHash, decisionHash });
}

// ── Dispatch authority ──────────────────────────────────────────────────────
//
// The captured decision — not the live agent row, not the environment — supplies
// the provider and model for a governed dispatch. This is the function that
// enforces it, and it is deliberately the ONLY way to obtain them.
function governedRouteForDispatch(decision, { actingAgent = null } = {}) {
  const captured = normalizeRoleRoutingDecision(decision);
  // Re-verify immediately before dispatch: the reference must still resolve to
  // the exact artifact captured. A moved alias or repointed tag refuses rather
  // than silently executing the replacement. Recovery uses this same path, so it
  // cannot select a new target either.
  try {
    assertDispatchTargetUnchanged({
      version: 1,
      targetKind: captured.targetKind,
      adapterId: captured.adapterId,
      provider: captured.provider,
      routeReference: captured.routeReference,
      dispatchTarget: captured.dispatchTarget,
      targetEvidenceIdentity: captured.targetEvidenceIdentity,
      targetEvidenceHash: captured.targetEvidenceHash
    });
  } catch (error) {
    refuse('route_target_drift', error.message || 'captured execution target no longer resolves');
  }
  // The acting agent may supply credentials through the existing secret seam,
  // but it must be the agent the decision names, and it may not change the
  // route. A different agent is a transplanted decision, not a re-route.
  if (actingAgent !== null && actingAgent.id !== captured.actingAgentId) {
    refuse('acting_agent_mismatch',
      `routingDecision names agent ${captured.actingAgentId}, not ${actingAgent.id}`);
  }
  return deepFreeze({
    adapterId: captured.adapterId,
    provider: captured.provider,
    // The immutable target, never the policy reference.
    model: captured.dispatchTarget,
    routeReference: captured.routeReference,
    targetEvidenceHash: captured.targetEvidenceHash,
    role: captured.role,
    decisionHash: captured.decisionHash
  });
}

module.exports = {
  CANONICAL_ROLES,
  FALLBACK_EVIDENCE_FIELDS,
  FALLBACK_REASONS,
  ROLE_POLICY_FIELDS,
  ROLE_ROUTING_DECISION_VERSION,
  ROLE_ROUTING_POLICY_VERSION,
  ROUTE_SELECTION_REASONS,
  ROUTING_DECISION_FIELDS,
  ROUTING_POLICY_FIELDS,
  ROUTING_REFUSALS,
  RoleRoutingError,
  SUBJECT_KINDS,
  UNGOVERNED_ROLE,
  assertCanonicalRole,
  buildRoleRoutingDecision,
  buildRoleRoutingPolicy,
  governedRouteForDispatch,
  normalizeRoleRoutingDecision,
  normalizeRoleRoutingPolicy,
  refuseRouting: refuse,
  rolePolicyFor,
  selectRoleRoute
};

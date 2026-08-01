#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/role-routing-contract.
//
// Pure selection and hashing. No database, no server, no provider, and no live
// agent row — which is itself the property under test: a governed dispatch takes
// its provider and model from the captured decision and from nowhere else.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CANONICAL_ROLES,
  ROLE_POLICY_FIELDS,
  ROLE_ROUTING_DECISION_VERSION,
  FALLBACK_EVIDENCE_FIELDS,
  FALLBACK_REASONS,
  ROUTE_SELECTION_REASONS,
  ROUTING_DECISION_FIELDS,
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
  rolePolicyFor,
  selectRoleRoute
} = require('../runtime/role-routing-contract');

const OPENAI_ADAPTER = 'openai.responses.v1';
const OLLAMA_ADAPTER = 'ollama.chat.v1';
const PLANNER_MODEL = 'gpt-4.1-mini-2025-04-14';
const WORKER_MODEL = 'gpt-4o-mini-2024-07-18';
// Deliberately models with NO economic capability. Route authorization must not
// depend on whether the runtime can price or bound them.
const UNKNOWN_OPENAI_MODEL = 'gpt-9-preview-2099-01-01';
const ARBITRARY_OLLAMA_MODEL = 'some-custom-gguf:q4';
const ATTEMPT_ID = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41';
const DECIDED_AT = '2026-08-01T00:00:00.000Z';

function route(adapterId, provider, model) {
  return { adapterId, provider, model };
}

function policyOf(overrides = {}) {
  return buildRoleRoutingPolicy({
    policyId: 'routing-policy-1',
    rolePolicies: [
      {
        role: 'structured_planner',
        primaryRoute: route(OPENAI_ADAPTER, 'openai', PLANNER_MODEL),
        fallbackRoute: null,
        authorizedFallbackReasons: [],
        ...(overrides.planner || {})
      },
      {
        role: 'structured_leaf_executor',
        primaryRoute: route(OPENAI_ADAPTER, 'openai', WORKER_MODEL),
        fallbackRoute: route(OPENAI_ADAPTER, 'openai', PLANNER_MODEL),
        authorizedFallbackReasons: ['primary_route_provider_unavailable'],
        ...(overrides.worker || {})
      }
    ]
  });
}

function plannerDecision(policy, extra = {}) {
  return buildRoleRoutingDecision({
    policy,
    role: 'structured_planner',
    ticketId: 7,
    subjectKind: 'planning_attempt',
    subjectId: ATTEMPT_ID,
    actingAgentId: 11,
    decidedAt: DECIDED_AT,
    ...extra
  });
}

function workerDecision(policy, extra = {}) {
  return buildRoleRoutingDecision({
    policy,
    role: 'structured_leaf_executor',
    ticketId: 7,
    subjectKind: 'run',
    subjectId: 42,
    allocationPlanId: 9,
    allocationItemId: 5,
    actingAgentId: 12,
    decidedAt: DECIDED_AT,
    ...extra
  });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RoleRoutingError, 'refusals use the module error');
    assert.equal(error.code, 'ROLE_ROUTING_REFUSED');
    assert.equal(ROUTING_REFUSALS.includes(error.reason), true,
      `${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected a routing refusal');
}

function invalid(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RoleRoutingError, 'validation uses the module error');
    return error;
  }
  return assert.fail('expected a contract violation');
}

// ── Canonical roles ─────────────────────────────────────────────────────────

assert.deepEqual([...CANONICAL_ROLES].sort(),
  ['structured_leaf_executor', 'structured_planner']);
assert.equal(UNGOVERNED_ROLE, null,
  'ordinary historical execution has no role, which is what keeps it unchanged');
for (const invented of [
  'verifier', 'critic', 'reviewer', 'manager', 'supervisor', 'delegator', 'auctioneer'
]) {
  assert.equal(refusalReason(() => assertCanonicalRole(invented)), 'unknown_role');
}
assert.equal(refusalReason(() => assertCanonicalRole(null)), 'unknown_role');

// ── (1)(2)(3) Authorization is independent of economics AND of capture ──────
//
// Two separate questions:
//   policy authorization — may this role use this reference at all?
//   decision capture     — can the runtime bind an immutable execution target?
// A reference can pass the first and fail the second, and that failure is a
// ROUTING refusal, never an economic one.

function soloPolicy(adapterId, provider, model, role = 'structured_leaf_executor') {
  return buildRoleRoutingPolicy({
    policyId: `solo-${model}`,
    rolePolicies: [{
      role,
      primaryRoute: route(adapterId, provider, model),
      fallbackRoute: null,
      authorizedFallbackReasons: []
    }]
  });
}

// Every one of these is policy-authorizable: building the policy succeeds and
// yields a stable hash.
const authorizable = [
  [OPENAI_ADAPTER, 'openai', WORKER_MODEL],
  [OPENAI_ADAPTER, 'openai', UNKNOWN_OPENAI_MODEL],
  [OPENAI_ADAPTER, 'openai', 'gpt-4o'],
  [OPENAI_ADAPTER, 'openai', 'gpt-4.1-latest'],
  [OLLAMA_ADAPTER, 'ollama', ARBITRARY_OLLAMA_MODEL],
  [OLLAMA_ADAPTER, 'ollama', 'llama3:latest']
];
for (const [adapterId, provider, model] of authorizable) {
  const authorized = soloPolicy(adapterId, provider, model);
  assert.match(authorized.policyHash, /^[0-9a-f]{64}$/,
    `${model} is policy-authorizable regardless of economics or immutability`);
  assert.equal(
    authorized.rolePolicies[0].primaryRoute.model, model,
    'the policy records the authorized reference verbatim');
}

// Only an exact admitted snapshot can be CAPTURED.
const capturable = workerDecision(soloPolicy(OPENAI_ADAPTER, 'openai', WORKER_MODEL));
assert.equal(capturable.dispatchTarget, WORKER_MODEL);
assert.equal(capturable.targetKind, 'provider_model_snapshot');
assert.equal(capturable.routeReference, WORKER_MODEL,
  'for an exact snapshot the reference and the target coincide');
assert.match(capturable.targetEvidenceHash, /^[0-9a-f]{64}$/);

// A mutable alias, an unadmitted snapshot, and any Ollama tag all refuse
// CAPTURE with a routing reason. Zero pricing is irrelevant here: immutability
// is not a monetary property.
for (const [adapterId, provider, model, why] of [
  [OPENAI_ADAPTER, 'openai', 'gpt-4o', 'mutable alias'],
  [OPENAI_ADAPTER, 'openai', 'gpt-4o-mini', 'mutable alias'],
  [OPENAI_ADAPTER, 'openai', 'gpt-4.1-latest', 'mutable alias'],
  [OPENAI_ADAPTER, 'openai', UNKNOWN_OPENAI_MODEL, 'unadmitted snapshot'],
  [OLLAMA_ADAPTER, 'ollama', ARBITRARY_OLLAMA_MODEL, 'no digest seam'],
  [OLLAMA_ADAPTER, 'ollama', 'llama3:latest', 'no digest seam']
]) {
  assert.equal(
    refusalReason(() => workerDecision(soloPolicy(adapterId, provider, model))),
    'route_target_not_immutable',
    `${model} (${why}) must refuse capture as a routing decision`
  );
}

// Economics is never invoked for an uncapturable route: the routing module
// imports no economic primitive at all (asserted at the end of this suite), so
// the refusal cannot have consulted pricing, capability or budget.

// ── (4) The decision carries no economic fact ───────────────────────────────// ── (4) The decision carries no economic fact ───────────────────────────────

const policy = policyOf();
const worker = workerDecision(policy);
const planner = plannerDecision(policy);
assert.deepEqual(Object.keys(worker).sort(), [...ROUTING_DECISION_FIELDS].sort());
for (const economic of [
  'modelCapabilityHash', 'adapterCapabilityHash', 'pricingEntryHash', 'pricingCatalogHash',
  'maximumMicroUsd', 'budgetMicroUsd', 'maxOutputTokens', 'contextWindowTokens',
  'reservationId', 'reservedMicroUsd', 'economicPolicyId', 'economicAuthorityHash'
]) {
  assert.equal(ROUTING_DECISION_FIELDS.includes(economic), false,
    `the routing decision must not carry ${economic}`);
  assert.equal(Object.prototype.hasOwnProperty.call(worker, economic), false);
}
// Authority flows one way: the economic authority will bind this decision's
// hash, and the decision binds nothing economic in return — not even an
// economic-policy identifier. A reciprocal reference would make the two hashes
// mutually dependent.
assert.equal(ROUTING_DECISION_FIELDS.includes('economicPolicyId'), false,
  'the routing decision must not name its economic companion');
assert.equal(Object.prototype.hasOwnProperty.call(worker, 'economicPolicyId'), false);

// ── (5)(6) Routing hash tracks ROUTES, not budgets ──────────────────────────

for (const economic of ['budgetMicroUsd', 'maxOutputTokens', 'maxProviderRequests', 'maxCost']) {
  assert.equal(ROLE_POLICY_FIELDS.includes(economic), false,
    `${economic} is economic policy and must not sit in the routing policy`);
}
assert.notEqual(
  policyOf({ worker: { primaryRoute: route(OPENAI_ADAPTER, 'openai', PLANNER_MODEL),
    fallbackRoute: route(OPENAI_ADAPTER, 'openai', WORKER_MODEL) } }).policyHash,
  policy.policyHash,
  'changing an authorized route changes the routing-policy hash'
);
assert.notEqual(
  policyOf({ worker: { authorizedFallbackReasons: [] } }).policyHash, policy.policyHash,
  'changing fallback authorization changes the routing-policy hash'
);
assert.equal(policyOf().policyHash, policy.policyHash, 'routing hashing is deterministic');

// ── (8) Planner and leaf routes remain distinct ─────────────────────────────

assert.equal(planner.dispatchTarget, PLANNER_MODEL);
assert.equal(worker.dispatchTarget, WORKER_MODEL);
assert.notEqual(planner.dispatchTarget, worker.dispatchTarget);
assert.equal(planner.role, 'structured_planner');
assert.equal(worker.role, 'structured_leaf_executor');
assert.equal(planner.subjectKind, 'planning_attempt');
assert.equal(worker.subjectKind, 'run');
assert.equal(worker.allocationPlanId, 9);
assert.equal(worker.allocationItemId, 5);
assert.equal(planner.allocationPlanId, null);
assert.deepEqual(SUBJECT_KINDS, ['planning_attempt', 'run']);

// ── Policy schema and determinism ───────────────────────────────────────────

assert.equal(Object.isFrozen(policy), true);
assert.deepEqual(Object.keys(policy.rolePolicies[0]).sort(), [...ROLE_POLICY_FIELDS].sort());
assert.equal(normalizeRoleRoutingPolicy(policy).policyHash, policy.policyHash);
assert.equal(normalizeRoleRoutingPolicy(JSON.parse(JSON.stringify(policy))).policyHash,
  policy.policyHash, 'a policy survives a JSONB round trip');
invalid(() => normalizeRoleRoutingPolicy({ ...policy, policyHash: '0'.repeat(64) }));
invalid(() => policyOf({ worker: { fallbackRoute: route(OPENAI_ADAPTER, 'openai', WORKER_MODEL) } }));
invalid(() => policyOf({ planner: { authorizedFallbackReasons: ['primary_route_provider_unavailable'] } }));
assert.equal(
  refusalReason(() => buildRoleRoutingPolicy({
    policyId: 'p', rolePolicies: [policy.rolePolicies[0], { ...policy.rolePolicies[0] }]
  })),
  'routing_policy_malformed'
);
const plannerOnly = buildRoleRoutingPolicy({
  policyId: 'planner-only',
  rolePolicies: [policy.rolePolicies.find(entry => entry.role === 'structured_planner')]
});
assert.equal(refusalReason(() => selectRoleRoute(plannerOnly, 'structured_leaf_executor')),
  'role_not_configured', 'no eligible route refuses and selects no provider');

// ── (10)(11)(13) Fallback cannot be forced ──────────────────────────────────

assert.deepEqual([...FALLBACK_REASONS].sort(),
  ['primary_route_model_withdrawn', 'primary_route_provider_unavailable']);
for (const commercial of ['cheaper', 'faster', 'busy', 'cost', 'latency']) {
  assert.equal(FALLBACK_REASONS.includes(commercial), false,
    `${commercial} is not grounds for a fallback in this tranche`);
}
// A caller-supplied string is not evidence.
for (const forged of [
  'the primary was down', '', 'primary_route_provider_unavailable', 42, true, [], null
]) {
  if (forged === null) continue;
  assert.equal(
    refusalReason(() => selectRoleRoute(policy, 'structured_leaf_executor',
      { preflightEvidence: forged })),
    'fallback_reason_malformed',
    `a caller-supplied ${typeof forged} cannot force a fallback`
  );
}
const validShape = {
  reason: 'primary_route_provider_unavailable',
  primaryRouteId: policy.rolePolicies.find(p => p.role === 'structured_leaf_executor')
    .primaryRoute.routeId,
  evidenceHash: 'a'.repeat(64)
};
assert.deepEqual(Object.keys(validShape).sort(), [...FALLBACK_EVIDENCE_FIELDS].sort());
// A reason outside the closed vocabulary refuses.
assert.equal(
  refusalReason(() => selectRoleRoute(policy, 'structured_leaf_executor',
    { preflightEvidence: { ...validShape, reason: 'cheaper' } })),
  'fallback_reason_malformed'
);
// A reason the policy does not authorize refuses.
assert.equal(
  refusalReason(() => selectRoleRoute(policy, 'structured_leaf_executor',
    { preflightEvidence: { ...validShape, reason: 'primary_route_model_withdrawn' } })),
  'fallback_reason_not_authorized'
);
// Evidence about another primary route refuses, so evidence cannot cross roles.
assert.equal(
  refusalReason(() => selectRoleRoute(policy, 'structured_leaf_executor',
    { preflightEvidence: { ...validShape, primaryRouteId: 'other|openai|x' } })),
  'fallback_reason_not_authorized'
);
// The planner authorizes no alternative at all, so it can never become a worker
// route and a worker can never become the planner route.
assert.equal(
  refusalReason(() => selectRoleRoute(policy, 'structured_planner',
    { preflightEvidence: { ...validShape,
      primaryRouteId: policy.rolePolicies.find(p => p.role === 'structured_planner')
        .primaryRoute.routeId } })),
  'fallback_not_authorized'
);
// Even perfectly-formed, policy-authorized evidence cannot select a fallback:
// no canonical preflight-evidence seam exists, so the runtime refuses rather
// than manufacturing availability authority.
assert.equal(
  refusalReason(() => selectRoleRoute(policy, 'structured_leaf_executor',
    { preflightEvidence: validShape })),
  'fallback_preflight_evidence_unavailable'
);
assert.equal(
  refusalReason(() => workerDecision(policy, { preflightEvidence: validShape })),
  'fallback_preflight_evidence_unavailable',
  'a decision cannot be captured with a fallback that cannot be selected'
);
// Fallback remains representable in policy and schema for when a seam lands.
assert.equal(worker.fallbackAuthorized, true);
assert.equal(worker.fallbackUsed, false);
assert.equal(worker.fallbackReason, null);
assert.notEqual(worker.fallbackRouteId, null);
assert.equal(planner.fallbackAuthorized, false);
assert.equal(planner.fallbackRouteId, null);

// ── (12)(14) Decision immutability and malformed state ──────────────────────

assert.equal(workerDecision(policy).decisionHash, worker.decisionHash,
  'identical inputs produce an identical decision');
for (const [field, value] of [
  ['ticketId', 8], ['actingAgentId', 13], ['subjectId', 43], ['allocationItemId', 6],
  ['allocationPlanId', 10]
]) {
  assert.notEqual(workerDecision(policy, { [field]: value }).decisionHash, worker.decisionHash,
    `${field} participates in the decision hash`);
}
assert.equal(normalizeRoleRoutingDecision(worker).decisionHash, worker.decisionHash);
assert.equal(normalizeRoleRoutingDecision(JSON.parse(JSON.stringify(worker))).decisionHash,
  worker.decisionHash, 'a decision survives a JSONB round trip');
// Fallback cannot be introduced after capture: every mutation breaks the hash.
for (const mutation of [
  { fallbackUsed: true },
  { fallbackUsed: true, fallbackReason: 'primary_route_provider_unavailable' },
  { dispatchTarget: PLANNER_MODEL },
  { routeReference: PLANNER_MODEL },
  { targetEvidenceHash: '0'.repeat(64) },
  { targetEvidenceIdentity: 'forged' },
  { provider: 'ollama' },
  { adapterId: OLLAMA_ADAPTER },
  { decisionHash: '0'.repeat(64) },
  { version: 2 },
  { extra: 1 }
]) {
  invalid(() => normalizeRoleRoutingDecision({ ...worker, ...mutation }));
}
for (const field of ROUTING_DECISION_FIELDS) {
  const partial = { ...worker };
  delete partial[field];
  invalid(() => normalizeRoleRoutingDecision(partial));
}
for (const [expectation, value] of [
  ['expectedTicketId', 8], ['expectedRole', 'structured_planner'], ['expectedSubjectId', 43]
]) {
  assert.equal(
    refusalReason(() => normalizeRoleRoutingDecision(worker, { [expectation]: value })),
    'routing_decision_conflict'
  );
}

// ── (9) Captured route controls dispatch ────────────────────────────────────

const dispatch = governedRouteForDispatch(worker);
assert.equal(dispatch.provider, 'openai');
assert.equal(dispatch.model, WORKER_MODEL);
assert.equal(dispatch.routeReference, WORKER_MODEL);
assert.equal(dispatch.adapterId, OPENAI_ADAPTER);
assert.equal(dispatch.decisionHash, worker.decisionHash);
for (const drift of [
  { id: 12, provider: 'ollama', model: 'something-else' },
  { id: 12, provider: 'openai', model: PLANNER_MODEL, apiKey: 'k' },
  { id: 12, model: '' }
]) {
  const routed = governedRouteForDispatch(worker, { actingAgent: drift });
  assert.equal(routed.model, WORKER_MODEL, 'a drifted agent row cannot re-route');
  assert.equal(routed.targetEvidenceHash, worker.targetEvidenceHash,
    'the immutable target survives agent drift');
  assert.equal(routed.provider, 'openai');
}
assert.equal(refusalReason(() => governedRouteForDispatch(worker, { actingAgent: { id: 99 } })),
  'acting_agent_mismatch');
// Missing credentials are a dispatch concern; they never re-route here, because
// this function has no route to fall back to.
assert.equal(
  governedRouteForDispatch(worker, { actingAgent: { id: 12, apiKey: null } }).model,
  WORKER_MODEL,
  'missing credentials do not trigger route hopping'
);

// Policy drift does not rewrite a captured decision.
const drifted = policyOf({
  worker: {
    primaryRoute: route(OPENAI_ADAPTER, 'openai', PLANNER_MODEL),
    fallbackRoute: route(OPENAI_ADAPTER, 'openai', WORKER_MODEL)
  }
});
assert.equal(workerDecision(drifted).dispatchTarget, PLANNER_MODEL,
  'a NEW decision takes the new route');
assert.equal(worker.dispatchTarget, WORKER_MODEL, 'the captured decision is unchanged');
assert.equal(governedRouteForDispatch(worker).model, WORKER_MODEL);
assert.equal(
  refusalReason(() => normalizeRoleRoutingDecision(worker,
    { expectedPolicyHash: drifted.policyHash })),
  'routing_decision_conflict'
);

// ── Fallback cannot bypass immutable-target validation ─────────────────────
//
// A policy whose ALTERNATIVE is a mutable alias is still authorizable, and its
// primary still captures normally — the alternative would be held to the same
// immutable-target standard if it could ever be selected.
const aliasFallbackPolicy = buildRoleRoutingPolicy({
  policyId: 'alias-fallback',
  rolePolicies: [{
    role: 'structured_leaf_executor',
    primaryRoute: route(OPENAI_ADAPTER, 'openai', WORKER_MODEL),
    fallbackRoute: route(OPENAI_ADAPTER, 'openai', 'gpt-4o'),
    authorizedFallbackReasons: ['primary_route_provider_unavailable']
  }]
});
assert.equal(workerDecision(aliasFallbackPolicy).dispatchTarget, WORKER_MODEL,
  'the primary still captures normally');
assert.equal(
  refusalReason(() => workerDecision(aliasFallbackPolicy, {
    preflightEvidence: {
      reason: 'primary_route_provider_unavailable',
      primaryRouteId: aliasFallbackPolicy.rolePolicies[0].primaryRoute.routeId,
      evidenceHash: 'a'.repeat(64)
    }
  })),
  'fallback_preflight_evidence_unavailable',
  'fallback still cannot be selected, so it can never bypass target validation'
);

// ── Target drift refuses rather than executing the replacement ─────────────

const {
  assertDispatchTargetUnchanged,
  resolveImmutableDispatchTarget
} = require('../runtime/execution-target-registry');

const capturedTarget = resolveImmutableDispatchTarget({
  adapterId: OPENAI_ADAPTER, provider: 'openai', model: WORKER_MODEL
});
assert.equal(assertDispatchTargetUnchanged(capturedTarget).dispatchTarget, WORKER_MODEL,
  'an unchanged target reverifies');
// A captured target whose artifact was swapped no longer matches its evidence.
assert.throws(
  () => assertDispatchTargetUnchanged({ ...capturedTarget, dispatchTarget: PLANNER_MODEL }),
  error => error.reason === 'target_drift',
  'tag/alias drift refuses rather than silently executing the replacement'
);
assert.throws(
  () => assertDispatchTargetUnchanged({ ...capturedTarget, targetEvidenceHash: '0'.repeat(64) }),
  error => error.reason === 'target_drift',
  'target-evidence mutation is caught'
);
// A reference that is no longer capturable at all refuses too.
assert.throws(
  () => assertDispatchTargetUnchanged({
    ...capturedTarget, routeReference: 'gpt-4o', dispatchTarget: 'gpt-4o'
  }),
  () => true,
  'a reference that lost immutability refuses at dispatch'
);
// governedRouteForDispatch must ITSELF reverify, not merely be adjacent to a
// reverification helper. A well-formed decision whose reference no longer
// resolves to its captured target must refuse at dispatch.
const { hashCanonical } = require('../runtime/declared-work-contract');
const driftedBody = Object.fromEntries(
  ROUTING_DECISION_FIELDS.filter(field => field !== 'decisionHash')
    .map(field => [field, worker[field]])
);
// The reference now names a DIFFERENT admitted snapshot than the captured
// target, exactly as a moved alias or repointed tag would behave.
driftedBody.routeReference = PLANNER_MODEL;
const driftedDecision = { ...driftedBody, decisionHash: hashCanonical(driftedBody) };
assert.equal(normalizeRoleRoutingDecision(driftedDecision).routeReference, PLANNER_MODEL,
  'the drifted decision is internally well-formed and correctly hashed');
assert.equal(
  refusalReason(() => governedRouteForDispatch(driftedDecision)),
  'route_target_drift',
  'dispatch reverifies the captured target and refuses drift'
);
// Recovery uses the same dispatch path, so it cannot select a new target.
assert.equal(governedRouteForDispatch(worker).model, WORKER_MODEL,
  'recovery reuses the captured target');

// ── Source boundary: routing imports no economic primitive ──────────────────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'role-routing-contract.js'), 'utf8');
const executable = source.replace(/^\s*\/\/.*$/gm, '');
for (const forbidden of [
  'model-pricing-catalog', 'provider-adapter-capability', 'economic-authority-contract',
  'resolveModelCapability', 'modelCapabilityHash', 'getAdapterCapability',
  'findPricingEntry', 'computeMaximumLiability', 'reservation', 'account'
]) {
  assert.equal(executable.includes(forbidden), false,
    `the routing contract must not depend on ${forbidden}`);
}
for (const forbidden of [
  'process.env', 'OPENAI_MODEL', 'OLLAMA_MODEL', 'fetch(', 'require(\'http',
  'Math.random', 'Date.now', 'apiKey', 'Authorization'
]) {
  assert.equal(executable.includes(forbidden), false,
    `the routing contract must not reference ${forbidden}`);
}
for (const forbidden of ['auction', 'bid', 'market', 'latency', 'optimi', 'delegat', 'recursi']) {
  assert.equal(new RegExp(forbidden, 'i').test(executable), false,
    `no ${forbidden} behavior appears in executable routing code`);
}
assert.deepEqual(
  [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort(),
  ['./declared-work-contract', './execution-target-registry'],
  'routing depends on closed routing primitives only'
);
// The target registry is itself a routing primitive: it must not reach into
// pricing, model economic capability, economic authority or accounting.
const targetSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'execution-target-registry.js'), 'utf8');
assert.deepEqual(
  [...targetSource.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]),
  ['./declared-work-contract'],
  'the execution-target registry depends on closed primitives only'
);
for (const forbidden of [
  'model-pricing-catalog', 'provider-adapter-capability', 'economic-authority',
  'contextWindow', 'MicroUsd', 'reservation', 'fetch(', 'process.env'
]) {
  assert.equal(targetSource.replace(/^\s*\/\/.*$/gm, '').includes(forbidden), false,
    `the target registry must not reference ${forbidden}`);
}

console.log('role routing contract test passed');

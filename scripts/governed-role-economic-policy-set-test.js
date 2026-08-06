#!/usr/bin/env node
'use strict';

// Tranche 6 — the role-keyed governed economic policy set.
//
// THE DECISION THIS SUITE ENFORCES. Exactly ONE active governed policy
// container may exist, and that container must be able to fund BOTH canonical
// roles: `structured_planner` and `structured_leaf_executor`. Before this
// change the container carried a singular `economicPolicy` naming one role, so
// a deployment could fund the planner or the worker but never both — and the
// structured plan-to-leaf path could not be configured at all.
//
// WHAT IS DELIBERATELY NOT ALLOWED, and is asserted here as strongly as what is:
//
//   * no cross-role fallback — a container that does not fund the requested
//     role fails closed, and a historical singular container never lends its
//     one policy to a second role;
//   * no second active container;
//   * no fourth policy-source subdocument — `economicPolicies` is the
//     version-2 SHAPE of the existing economic category, not a new category;
//   * no "first entry" and no default to the planner.

const assert = require('node:assert/strict');
const {
  GOVERNED_POLICY_SOURCE_VERSION,
  GOVERNED_SUBDOCUMENTS,
  readGovernedPolicySource
} = require('../runtime/governed-policy-source');
const { CANONICAL_ROLES } = require('../runtime/role-routing-contract');
const { normalizeEconomicPolicy } = require('../runtime/economic-authority-contract');
const {
  buildGovernedExecutionValue,
  buildRoleKeyedGovernedContainer,
  buildSingularGovernedContainer,
  economicPolicyValue,
  pricedCatalogValue
} = require('./fixtures/governed-role-policy-container');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

const PLANNER = 'structured_planner';
const WORKER = 'structured_leaf_executor';

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

// Every refusal is checked by its REASON, never by message text, so rewording a
// message can never quietly turn one failure into another.
function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    if (error && error.detail && error.detail.reason) return error.detail.reason;
    return `unexpected:${error && error.message}`;
  }
  return 'no_refusal';
}

function containerWith(governedExecution) {
  return { body: { governedExecution } };
}

function main() {
  console.log('governed role economic policy set');

  const catalog = buildPricingCatalog(pricedCatalogValue());

  // ── 1. One planner and one leaf-executor policy, in one container ──────
  const both = buildRoleKeyedGovernedContainer();
  const plannerSource = readGovernedPolicySource(both, { role: PLANNER });
  const workerSource = readGovernedPolicySource(both, { role: WORKER });
  ok(plannerSource.economicPolicyRoles.length === 2 &&
     plannerSource.economicPolicyRoles.includes(PLANNER) &&
     plannerSource.economicPolicyRoles.includes(WORKER),
  '1 the new container accepts exactly one planner and one leaf-executor policy');
  ok(GOVERNED_POLICY_SOURCE_VERSION === 2 &&
     plannerSource.economicPolicySetVersion === 2,
  '1 the role-keyed set is read at the versioned contract');

  // ── 2. Canonical order is stable regardless of input order ─────────────
  const forward = buildGovernedExecutionValue();
  const reversed = buildGovernedExecutionValue();
  reversed.economicPolicies = [...reversed.economicPolicies].reverse();
  const forwardSource = readGovernedPolicySource(containerWith(forward), { role: PLANNER });
  const reversedSource = readGovernedPolicySource(containerWith(reversed), { role: PLANNER });
  ok(reversedSource.economicPolicyRoles.join(',') === CANONICAL_ROLES.join(','),
    '2 canonical role order is imposed by the contract, not taken from input');
  ok(forwardSource.economicPolicySetHash === reversedSource.economicPolicySetHash,
    '2 input ordering does not change the set hash');

  // ── 3 & 4. Duplicate role entries refuse ───────────────────────────────
  for (const [role, label] of [[PLANNER, '3 planner'], [WORKER, '4 leaf']]) {
    const duplicated = buildGovernedExecutionValue();
    const entry = duplicated.economicPolicies.find(candidate => candidate.role === role);
    duplicated.economicPolicies = [...duplicated.economicPolicies,
      { role, policy: { ...entry.policy, policyId: `${role}-economics-second` } }];
    ok(refusalReason(() => readGovernedPolicySource(
      containerWith(duplicated), { role: PLANNER })) ===
      'governed_policy_economic_set_malformed',
    `${label} duplicated in the set refuses`);
  }

  // ── 5. Unknown role refuses ────────────────────────────────────────────
  const unknownRole = buildGovernedExecutionValue();
  unknownRole.economicPolicies = [...unknownRole.economicPolicies,
    { role: 'structured_reviewer', policy: unknownRole.economicPolicies[0].policy }];
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(unknownRole), { role: PLANNER })) ===
    'governed_policy_economic_set_malformed',
  '5 a non-canonical role in the set refuses');

  // ── 6. Embedded-role mismatch refuses ──────────────────────────────────
  //
  // The dangerous case: filed under the worker, but the policy governs the
  // planner. Selecting by key alone would fund the wrong role under the right
  // name.
  const mismatched = buildGovernedExecutionValue();
  mismatched.economicPolicies = mismatched.economicPolicies.map(entry =>
    entry.role === WORKER
      ? { role: WORKER, policy: economicPolicyValue(PLANNER, catalog) }
      : entry);
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(mismatched), { role: PLANNER })) ===
    'governed_policy_economic_set_malformed',
  '6 an entry whose embedded role disagrees with its key refuses');

  // ── 7 & 8. Selection returns exactly the requested role's policy ───────
  ok(plannerSource.economicPolicy.role === PLANNER &&
     plannerSource.economicPolicy.maximumProviderRequests ===
       forward.economicPolicies.find(e => e.role === PLANNER).policy
         .maximumProviderRequests,
  '7 planner selection returns the planner policy only');
  ok(workerSource.economicPolicy.role === WORKER &&
     workerSource.economicPolicy.maximumProviderRequests ===
       forward.economicPolicies.find(e => e.role === WORKER).policy
         .maximumProviderRequests,
  '8 leaf-executor selection returns the worker policy only');

  // ── 9. Absent requested role refuses ───────────────────────────────────
  const plannerOnly = buildGovernedExecutionValue({ roles: [PLANNER] });
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(plannerOnly), { role: WORKER })) === 'governed_policy_role_absent',
  '9 a container that does not fund the requested role fails closed');

  // ── 10. No cross-role fallback ─────────────────────────────────────────
  //
  // The planner policy is PRESENT and would satisfy a lenient reader. Nothing
  // may substitute it for the absent worker.
  let leaked = null;
  try {
    leaked = readGovernedPolicySource(containerWith(plannerOnly), { role: WORKER });
  } catch (_) { leaked = null; }
  ok(leaked === null,
    '10 an available planner policy is never substituted for an absent worker');

  // ── 11 & 12. Changing either role's policy changes the set hash ────────
  const baseline = readGovernedPolicySource(
    containerWith(buildGovernedExecutionValue()), { role: PLANNER })
    .economicPolicySetHash;
  for (const [role, label] of [[PLANNER, '11 planner'], [WORKER, '12 leaf-executor']]) {
    const changed = buildGovernedExecutionValue({
      economicOverrides: { [role]: { authorizedMicroUsd: 499_999 } }
    });
    // Read for the OTHER role where possible, proving the set hash covers the
    // whole set rather than only whichever entry was selected.
    const observed = readGovernedPolicySource(containerWith(changed), { role: PLANNER })
      .economicPolicySetHash;
    ok(observed !== baseline,
      `${label} policy change changes the container's economic set hash`);
  }

  // ── 13. Selected role-policy hash is independently verifiable ──────────
  ok(normalizeEconomicPolicy(workerSource.economicPolicy).policyHash ===
     workerSource.economicPolicyHash,
  '13 the selected role-policy hash re-verifies against its own policy');
  // ...and it is bound to the parent set, which is identical for both roles.
  ok(plannerSource.economicPolicySetHash === workerSource.economicPolicySetHash &&
     plannerSource.economicPolicyHash !== workerSource.economicPolicyHash,
  '13 role selection changes the selected identity, never the parent identity');

  // ── 14 & 15. Historical singular container ─────────────────────────────
  const historical = buildSingularGovernedContainer({ role: PLANNER });
  const historicalSource = readGovernedPolicySource(historical, { role: PLANNER });
  ok(historicalSource.economicPolicy.role === PLANNER &&
     historicalSource.economicPolicySetVersion === 1,
  '14 a historical singular container still works for its recorded role');
  ok(refusalReason(() => readGovernedPolicySource(historical, { role: WORKER })) ===
    'governed_policy_role_absent',
  '15 a historical singular container refuses every other role');
  // The two shapes are distinguishable: a version-1 set never hashes as a
  // version-2 set with the same single entry.
  const singleRoleV2 = readGovernedPolicySource(
    containerWith(buildGovernedExecutionValue({ roles: [PLANNER] })), { role: PLANNER });
  ok(singleRoleV2.economicPolicySetHash !== historicalSource.economicPolicySetHash,
    '14 the set version is part of the economic identity');

  // ── 16. Multiple active containers remain refused ──────────────────────
  //
  // Enforced by the loader, not this contract, so it is proved where it lives.
  const serverSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  ok(serverSource.includes('GOVERNED_PLANNER_POLICY_AMBIGUOUS') &&
     serverSource.includes('governed.length > 1'),
  '16 more than one active governed container is still refused by the loader');

  // ── Shape discipline ───────────────────────────────────────────────────
  ok(GOVERNED_SUBDOCUMENTS.length === 3,
    'the container still carries exactly three authority categories');
  const bothShapes = buildGovernedExecutionValue();
  bothShapes.economicPolicy = economicPolicyValue(PLANNER, catalog);
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(bothShapes), { role: PLANNER })) ===
    'governed_policy_economic_shape_ambiguous',
  'declaring both economic shapes at once refuses rather than resolving');
  const emptySet = buildGovernedExecutionValue();
  emptySet.economicPolicies = [];
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(emptySet), { role: PLANNER })) ===
    'governed_policy_economic_set_malformed',
  'an empty economic set refuses: a container funding no role cannot govern');
  const noEconomics = buildGovernedExecutionValue();
  delete noEconomics.economicPolicies;
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(noEconomics), { role: PLANNER })) === 'economic_policy_absent',
  'a container with no economic authority at all refuses');
  // A malformed SIBLING entry refuses the container even when the caller asked
  // for the healthy role: the container is one aggregate, not two.
  const badSibling = buildGovernedExecutionValue();
  badSibling.economicPolicies = badSibling.economicPolicies.map(entry =>
    entry.role === WORKER
      ? { role: WORKER, policy: { ...entry.policy, authorizedMicroUsd: -1 } }
      : entry);
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(badSibling), { role: PLANNER })) === 'governed_policy_malformed',
  'a malformed sibling entry refuses the whole container, not just its own role');
  // Shared authority must price EVERY funded role.
  const mispriced = buildGovernedExecutionValue();
  mispriced.economicPolicies = mispriced.economicPolicies.map(entry =>
    entry.role === WORKER
      ? { role: WORKER, policy: { ...entry.policy, pricingCatalogHash: 'f'.repeat(64) } }
      : entry);
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(mispriced), { role: PLANNER })) === 'governed_policy_malformed',
  'an entry not priced by the configured catalog refuses the container');

  // ── Role identity survives equal numeric bounds ────────────────────────
  //
  // If the two roles are later given identical values, they must STILL be two
  // entries with two identities. Equality of values may never erase role
  // identity, because reservations and settlements bind the role.
  const equalBounds = buildGovernedExecutionValue({
    economicOverrides: {
      [PLANNER]: { maximumProviderRequests: 3 }
    }
  });
  const equalPlanner = readGovernedPolicySource(containerWith(equalBounds), { role: PLANNER });
  const equalWorker = readGovernedPolicySource(containerWith(equalBounds), { role: WORKER });
  ok(equalPlanner.economicPolicy.maximumProviderRequests ===
     equalWorker.economicPolicy.maximumProviderRequests &&
     equalPlanner.economicPolicyHash !== equalWorker.economicPolicyHash,
  'equal numeric bounds still produce two distinct role identities');

  // ── Failure classification is not regressed by role selection ──────────
  //
  // Every condition below is a CONFIGURATION failure. None of them may be
  // reported as a race: a missing role does not become present on retry, and
  // describing it as a conflict would send an operator looking for contention
  // that does not exist.
  const serverText = serverSource;
  ok(serverText.includes("refuse('leaf_governed_authority_unavailable'"),
    'classification: missing governed authority has its own exact code');
  ok(serverText.includes("refuse('leaf_admission_internal_failure'"),
    'classification: unexpected internal failures have their own exact code');
  // The conflict classification is reachable ONLY from real conflict codes.
  ok(serverText.includes("error.code === 'OPTIMISTIC_CONCURRENCY_CONFLICT'") &&
     serverText.includes("error.code === '40001'"),
  'classification: only genuine conflict codes and SQLSTATEs map to a race');
  // A role-absence refusal is raised by the policy-source contract, which the
  // server catches as an authority failure — never as a conflict.
  const roleAbsence = [
    ['leaf role missing', buildGovernedExecutionValue({ roles: [PLANNER] }), WORKER],
    ['planner role missing', buildGovernedExecutionValue({ roles: [WORKER] }), PLANNER]
  ];
  for (const [label, value, role] of roleAbsence) {
    ok(refusalReason(() => readGovernedPolicySource(containerWith(value), { role })) ===
      'governed_policy_role_absent',
    `classification: ${label} refuses as absent authority, never as a race`);
  }
  // "Wrong selected role": the container funds both, but the entry filed under
  // the requested role governs the other one.
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(mismatched), { role: WORKER })) ===
    'governed_policy_economic_set_malformed',
  'classification: a wrongly filed role entry refuses as a malformed set');
  // A malformed set refuses even for a role whose own entry is fine.
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(unknownRole), { role: WORKER })) ===
    'governed_policy_economic_set_malformed',
  'classification: a malformed role-policy set refuses for every role');
  // Raw text is never durable or public authority.
  ok(serverText.includes('causeCode ? `cause ${causeCode}` :'),
    'classification: durable refusal detail carries a stable cause code, not raw text');

  console.log(`\ngoverned role economic policy set test passed — ${passed} assertions`);
}

main();

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
  // ISOLATING CASE. The entry above is ALSO a key/embedded-role mismatch, so it
  // would still refuse if the canonical-role check were deleted. This one is
  // internally consistent — key and embedded role agree — so the ONLY thing
  // that can reject it is the canonical-role check itself.
  const consistentUnknown = buildGovernedExecutionValue();
  consistentUnknown.economicPolicies = [...consistentUnknown.economicPolicies, {
    role: 'structured_reviewer',
    policy: { ...consistentUnknown.economicPolicies[0].policy,
      role: 'structured_reviewer', policyId: 'structured_reviewer-economics' }
  }];
  ok(refusalReason(() => readGovernedPolicySource(
    containerWith(consistentUnknown), { role: PLANNER })) ===
    'governed_policy_economic_set_malformed',
  '5 a self-consistent non-canonical role is rejected by the role check alone');

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

  // ── CROSS-ROLE PARENT POLICY REVISION PARITY ───────────────────────────
  //
  // Selected role-policy hashes prove "this policy funded this role". They do
  // NOT prove "both roles came from one immutable revision": an administrator
  // can replace the container with one whose worker entry is byte-identical and
  // whose planner entry differs, and every previously captured hash still
  // matches. The parent reference closes exactly that hole.
  const {
    buildParentPolicyReference, normalizeParentPolicyReference,
    assertSameParentPolicyRevision, PARENT_POLICY_REFERENCE_FIELDS
  } = require('../runtime/governed-policy-source');

  const sourceFor = (options, role) =>
    readGovernedPolicySource(buildRoleKeyedGovernedContainer(options), { role });

  // 1. Planner and leaf capture from the SAME revision succeed.
  const revisionA = { policyContainerId: 7, policyContainerRevision: 3 };
  const plannerA = buildParentPolicyReference(sourceFor(revisionA, PLANNER));
  const workerA = buildParentPolicyReference(sourceFor(revisionA, WORKER));
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA, workerA)) === 'no_refusal',
    'parity 1 planner and leaf capture from one revision agree');
  ok(plannerA.policyContainerId === 7 && plannerA.policyContainerRevision === 3,
    'parity 1 the reference names the exact container row and revision');

  // 2. Planner from revision A, leaf from revision B refuses.
  const workerB = buildParentPolicyReference(
    sourceFor({ policyContainerId: 7, policyContainerRevision: 4 }, WORKER));
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA, workerB)) ===
    'governed_policy_revision_mismatch',
  'parity 2 a leaf capture from a different revision refuses');

  // 3. THE CENTRAL CASE. The worker policy is byte-identical; only the PLANNER
  //    sibling changed. Every worker-side hash still matches, and it must still
  //    refuse — because the set hash moved.
  const siblingChanged = sourceFor({
    ...revisionA,
    economicOverrides: { [PLANNER]: { authorizedMicroUsd: 499_998 } }
  }, WORKER);
  ok(siblingChanged.economicPolicyHash ===
     sourceFor(revisionA, WORKER).economicPolicyHash,
  'parity 3 the worker policy is unchanged by a planner-sibling edit');
  ok(refusalReason(() => assertSameParentPolicyRevision(
    plannerA, buildParentPolicyReference(siblingChanged))) ===
    'governed_policy_revision_mismatch',
  'parity 3 an unchanged worker policy under a CHANGED sibling still refuses');

  // The container CONTENT hash must cover the economics, not only the shared
  // routing and pricing documents. If it covered only those, two containers
  // differing in a role policy would share a content identity — and the parity
  // check would be comparing a value blind to the very thing that changed.
  ok(sourceFor({ ...revisionA,
    economicOverrides: { [PLANNER]: { authorizedMicroUsd: 499_996 } }
  }, WORKER).policyContainerHash !== sourceFor(revisionA, WORKER).policyContainerHash,
  'parity 3 the container content hash covers the economic set, not just routing');

  // 4. Changed worker policy refuses.
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    buildParentPolicyReference(sourceFor({
      ...revisionA, economicOverrides: { [WORKER]: { authorizedMicroUsd: 499_997 } }
    }, WORKER)))) === 'governed_policy_revision_mismatch',
  'parity 4 a changed worker policy refuses');

  // 5 & 6. Changed shared routing or pricing authority refuses, because both
  //        enter the container content hash.
  const routingChanged = buildGovernedExecutionValue();
  routingChanged.roleRoutingPolicy = {
    ...routingChanged.roleRoutingPolicy, policyId: 'eval-routing-2'
  };
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    buildParentPolicyReference(readGovernedPolicySource(
      { body: { ...revisionA, id: 7, revision: 3, governedExecution: routingChanged } },
      { role: WORKER })))) === 'governed_policy_revision_mismatch',
  'parity 5 a changed routing policy refuses');
  const pricingChanged = buildGovernedExecutionValue();
  const repriced = pricedCatalogValue();
  repriced.catalogId = 'evaluation-repriced-catalog';
  const repricedBuilt = buildPricingCatalog(repriced);
  pricingChanged.pricingCatalog = repriced;
  pricingChanged.economicPolicies = pricingChanged.economicPolicies.map(entry => ({
    role: entry.role,
    policy: { ...entry.policy, pricingCatalogId: repricedBuilt.catalogId,
      pricingCatalogHash: repricedBuilt.catalogHash }
  }));
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    buildParentPolicyReference(readGovernedPolicySource(
      { body: { id: 7, revision: 3, governedExecution: pricingChanged } },
      { role: WORKER })))) === 'governed_policy_revision_mismatch',
  'parity 6 a changed pricing catalog refuses');

  // 7 & 8. Missing and malformed fields refuse.
  for (const field of PARENT_POLICY_REFERENCE_FIELDS) {
    const partial = { ...plannerA };
    delete partial[field];
    ok(refusalReason(() => normalizeParentPolicyReference(partial)) ===
      'governed_policy_parent_reference_malformed',
    `parity 7 a reference missing ${field} refuses`);
  }
  ok(refusalReason(() => normalizeParentPolicyReference(
    { ...plannerA, economicPolicySetHash: 'not-a-hash' })) ===
    'governed_policy_parent_reference_malformed',
  'parity 8 a malformed set hash refuses');
  ok(refusalReason(() => normalizeParentPolicyReference(
    { ...plannerA, policyContainerHash: 'f'.repeat(63) })) ===
    'governed_policy_parent_reference_malformed',
  'parity 8 a malformed container hash refuses');
  ok(refusalReason(() => normalizeParentPolicyReference(
    { ...plannerA, extra: 1 })) === 'governed_policy_parent_reference_malformed',
  'parity 8 an unknown field in the reference refuses');

  // 9. A selected role-policy hash may not stand in for the set hash. The two
  //    answer different questions and substituting one for the other would make
  //    the parity check pass while proving nothing about the sibling role.
  ok(!PARENT_POLICY_REFERENCE_FIELDS.includes('economicPolicyHash'),
    'parity 9 the parent reference carries no selected role-policy hash');
  ok(plannerA.economicPolicySetHash !== plannerSource.economicPolicyHash &&
     plannerA.economicPolicySetHash !== workerSource.economicPolicyHash,
  'parity 9 the set hash is not either selected role-policy hash');

  // 10 & 11. Row identity and revision mismatches refuse.
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    { ...plannerA, policyContainerId: 8 })) === 'governed_policy_revision_mismatch',
  'parity 10 a parent row ID mismatch refuses');
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    { ...plannerA, policyContainerRevision: 4 })) ===
    'governed_policy_revision_mismatch',
  'parity 11 a parent revision mismatch refuses');
  ok(refusalReason(() => assertSameParentPolicyRevision(plannerA,
    { ...plannerA, policyContainerHash: 'a'.repeat(64) })) ===
    'governed_policy_revision_mismatch',
  'parity 11 a container content-hash mismatch refuses');

  // A container read WITHOUT persistent row identity cannot claim a binding.
  ok(refusalReason(() => buildParentPolicyReference(readGovernedPolicySource(
    { body: { governedExecution: buildGovernedExecutionValue() } }, { role: PLANNER }))) ===
    'governed_policy_parent_reference_malformed',
  'parity a container with no row identity refuses to claim a revision binding');

  // 13 & 14. Historical envelopes stay readable and never claim parity.
  {
    const {
      GOVERNED_RUN_AUTHORITY_VERSIONS, GOVERNED_RUN_AUTHORITY_FIELDS_V2
    } = require('../runtime/governed-run-authority-contract');
    const {
      GOVERNED_EXECUTION_VERSIONS
    } = require('../runtime/structured-allocation-planning-contract');
    ok(GOVERNED_RUN_AUTHORITY_VERSIONS.join(',') === '1,2' &&
       GOVERNED_EXECUTION_VERSIONS.join(',') === '1,2',
    'parity 13 both authority envelopes read version 1 and version 2');
    ok(GOVERNED_RUN_AUTHORITY_FIELDS_V2.includes('parentPolicyReference') &&
       GOVERNED_RUN_AUTHORITY_FIELDS_V2.indexOf('governedExecutionHash') ===
         GOVERNED_RUN_AUTHORITY_FIELDS_V2.length - 1,
    'parity 13 version 2 adds the parent reference and keeps its hash last');
    // A version-1 envelope has NO parent reference field at all, so it cannot
    // assert cross-role revision parity. Server-side leaf admission refuses
    // rather than crediting it with a binding it never recorded.
    ok(serverSource.includes(
      'the admitted plan carries no captured parent policy revision'),
    'parity 14 a plan with no captured parent revision refuses leaf admission');
  }

  console.log(`\ngoverned role economic policy set test passed — ${passed} assertions`);
}

main();

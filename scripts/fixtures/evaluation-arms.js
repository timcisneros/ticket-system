'use strict';

// Tranche 6 — the five comparison configurations, and the predicate that proves
// each one reaches the production path it claims.
//
// WHY A PREDICATE AND NOT A COMMENT. The whole evaluation rests on each arm
// exercising a DIFFERENT production path. A configuration that silently fell
// back to another path would produce a comparison of one path against itself and
// report it as a product result. So the routing rule is expressed here as
// executable source, derived from the real dispatch conditions in `server.js`,
// and the harness refuses a trial whose configuration does not reach its
// intended path.
//
// THE THREE REAL PATHS, from source:
//
//   direct        assignmentTargetType 'agent' forces assignmentMode
//                 'individual'; ticketWorkspaceScope -> 'shared'; one Run; no
//                 plan; selectRunProviderPath finds no leafRunBinding, so the
//                 provider path is UNGOVERNED.
//
//   legacy_v1     assignmentTargetType 'group' with mode 'allocated' or
//                 'dynamic' and NO declaredWork. hasStructuredPlanningAuthority
//                 is false, so the ticket keeps the v1 path:
//                 buildAllocatedOwnershipPlan — one item per group agent, a
//                 generic subtask, operator paths (allocated) or
//                 deriveDynamicOwnedPaths (dynamic). No planner model call.
//                 Ungoverned.
//
//   structured_v2 assignmentTargetType 'group', declaredWork supplied whose
//                 objective exactly equals the ticket objective, and a group
//                 carrying plannerAgentId. That builds
//                 structuredAllocationAuthorityDraft;
//                 hasStructuredPlanningAuthority then routes to
//                 runStructuredAllocationPlanning -> planner request -> plan
//                 admission -> admitStructuredAllocationLeafRuns -> governed
//                 leaf Runs.
//
// ALLOCATED VERSUS DYNAMIC IS A SECONDARY FACTOR, present in both legacy_v1 and
// structured_v2. It decides only who supplies ownedOutputPaths: the operator, or
// deriveDynamicOwnedPaths. Collapsing the two into one cell would destroy the
// secondary comparison, so they are separate arms with separate identities.

const PRODUCTION_PATHS = Object.freeze(['direct', 'legacy_v1', 'structured_v2']);

const OWNERSHIP_SOURCES = Object.freeze(['none', 'operator', 'system_derived']);

class EvaluationArmError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'EvaluationArmError';
    this.detail = detail;
  }
}

// The five frozen configurations. `armId` is the experimental cell identity and
// is never shared between two cells.
const ARMS = Object.freeze({
  A: Object.freeze({
    armId: 'A',
    label: 'direct individual execution',
    family: 'direct',
    assignmentTargetType: 'agent',
    assignmentMode: 'individual',
    declaredWork: false,
    plannerAgent: false,
    ownershipSource: 'none',
    expectedPath: 'direct',
    expectedGoverned: false,
    expectedPlannerRequests: 0,
    expectedRunCardinality: 'one'
  }),
  A2a: Object.freeze({
    armId: 'A2a',
    label: 'legacy v1 group, operator allocated ownership',
    family: 'legacy_baseline',
    assignmentTargetType: 'group',
    assignmentMode: 'allocated',
    declaredWork: false,
    plannerAgent: false,
    ownershipSource: 'operator',
    expectedPath: 'legacy_v1',
    expectedGoverned: false,
    expectedPlannerRequests: 0,
    expectedRunCardinality: 'per_agent'
  }),
  A2b: Object.freeze({
    armId: 'A2b',
    label: 'legacy v1 group, system-derived ownership',
    family: 'legacy_baseline',
    assignmentTargetType: 'group',
    assignmentMode: 'dynamic',
    declaredWork: false,
    plannerAgent: false,
    ownershipSource: 'system_derived',
    expectedPath: 'legacy_v1',
    expectedGoverned: false,
    expectedPlannerRequests: 0,
    expectedRunCardinality: 'per_agent'
  }),
  B: Object.freeze({
    armId: 'B',
    label: 'structured v2, operator allocated ownership',
    family: 'structured',
    assignmentTargetType: 'group',
    assignmentMode: 'allocated',
    declaredWork: true,
    plannerAgent: true,
    ownershipSource: 'operator',
    expectedPath: 'structured_v2',
    expectedGoverned: true,
    expectedPlannerRequests: 1,
    expectedRunCardinality: 'per_plan_item'
  }),
  C: Object.freeze({
    armId: 'C',
    label: 'structured v2, system-derived ownership',
    family: 'structured',
    assignmentTargetType: 'group',
    assignmentMode: 'dynamic',
    declaredWork: true,
    plannerAgent: true,
    ownershipSource: 'system_derived',
    expectedPath: 'structured_v2',
    expectedGoverned: true,
    expectedPlannerRequests: 1,
    expectedRunCardinality: 'per_plan_item'
  })
});

const ARM_IDS = Object.freeze(Object.keys(ARMS));

// THE ROUTING RULE, transcribed from server.js dispatch conditions.
//
// Deliberately expressed over the ticket-shaping inputs an operator actually
// supplies, so a configuration error is caught before a trial runs rather than
// being discovered in the results.
function predictProductionPath({
  assignmentTargetType,
  assignmentMode,
  declaredWorkSupplied,
  plannerAgentPresent
}) {
  if (assignmentTargetType === 'agent') {
    // Ticket normalization forces individual mode for an agent target. There is
    // no way to reach an allocation plan from here.
    return 'direct';
  }
  if (assignmentTargetType !== 'group') {
    throw new EvaluationArmError(
      `unsupported assignmentTargetType: ${String(assignmentTargetType)}`);
  }
  if (!['allocated', 'dynamic'].includes(assignmentMode)) {
    throw new EvaluationArmError(
      `a group ticket must be allocated or dynamic, not ${String(assignmentMode)}`);
  }
  // structuredAllocationAuthorityDraft is built only when declaredWork is
  // supplied, and planning authority additionally requires a planner agent on
  // the group. Without BOTH, the ticket keeps the v1 path — which is precisely
  // how the A2a/A2b baseline is reached.
  if (declaredWorkSupplied && plannerAgentPresent) return 'structured_v2';
  return 'legacy_v1';
}

// Refuse a trial whose configuration does not reach its arm's intended path.
//
// This is the guard the protocol requires: "The harness must refuse when a
// configuration accidentally reaches another path." It is called before the
// trial runs AND again against observed durable facts afterwards.
function assertArmReachesIntendedPath(arm, configured) {
  const predicted = predictProductionPath({
    assignmentTargetType: configured.assignmentTargetType,
    assignmentMode: configured.assignmentMode,
    declaredWorkSupplied: Boolean(configured.declaredWorkSupplied),
    plannerAgentPresent: Boolean(configured.plannerAgentPresent)
  });
  if (predicted !== arm.expectedPath) {
    throw new EvaluationArmError(
      `arm ${arm.armId} is configured to reach ${predicted}, not its intended ` +
      `${arm.expectedPath} — refusing the trial`,
      { armId: arm.armId, predicted, expected: arm.expectedPath });
  }
  if (Boolean(configured.declaredWorkSupplied) !== arm.declaredWork) {
    throw new EvaluationArmError(
      `arm ${arm.armId} requires declaredWork=${arm.declaredWork}`,
      { armId: arm.armId });
  }
  if (configured.assignmentMode !== arm.assignmentMode) {
    throw new EvaluationArmError(
      `arm ${arm.armId} requires assignmentMode ${arm.assignmentMode}`,
      { armId: arm.armId });
  }
  return predicted;
}

// AFTER the trial: prove from durable facts that the path actually taken is the
// one the arm claims. A configuration can be right and the run still land
// elsewhere — a refused planner, a fallback — and that must invalidate the
// trial rather than silently mislabel it.
//
// `observed` carries only durable counts the reader collected.
function assertObservedPathMatches(arm, observed) {
  const {
    structuredPlanAdmitted = false,
    plannerRequestCount = 0,
    governedLeafRunCount = 0,
    allocationPlanPresent = false,
    runCount = 0,
    // A durable structured PLANNING ATTEMPT. A trial whose planning was
    // attempted and then blocked makes no planner reservation and admits no
    // plan, but it unquestionably ran the structured path — and calling that
    // "the structured path did not run" would discard a truthful product
    // outcome as a harness error.
    planningAttempts = 0
  } = observed;

  const observedPath = structuredPlanAdmitted || governedLeafRunCount > 0
    ? 'structured_v2'
    : (allocationPlanPresent ? 'legacy_v1' : 'direct');

  if (observedPath !== arm.expectedPath) {
    throw new EvaluationArmError(
      `arm ${arm.armId} was configured for ${arm.expectedPath} but durable facts ` +
      `show ${observedPath} — the trial is invalid, not merely different`,
      { armId: arm.armId, observedPath, expected: arm.expectedPath });
  }
  if (arm.expectedPlannerRequests === 0 && plannerRequestCount > 0) {
    throw new EvaluationArmError(
      `arm ${arm.armId} must make no planner request but made ${plannerRequestCount}`,
      { armId: arm.armId });
  }
  if (arm.expectedPlannerRequests > 0 &&
      plannerRequestCount === 0 && planningAttempts === 0) {
    throw new EvaluationArmError(
      `arm ${arm.armId} shows neither a planner request nor a planning attempt ` +
      '— the structured path did not actually run',
      { armId: arm.armId });
  }
  // Governed leaf Runs exist only once a plan is admitted. Requiring them
  // unconditionally would refuse a structured trial that was truthfully
  // blocked during planning, which is a product result rather than an invalid
  // trial.
  if (arm.expectedGoverned && allocationPlanPresent && governedLeafRunCount === 0) {
    throw new EvaluationArmError(
      `arm ${arm.armId} admitted a plan but produced no governed leaf Runs`,
      { armId: arm.armId });
  }
  if (!arm.expectedGoverned && governedLeafRunCount > 0) {
    throw new EvaluationArmError(
      `arm ${arm.armId} must be ungoverned but produced ${governedLeafRunCount} ` +
      'governed leaf Runs',
      { armId: arm.armId });
  }
  if (arm.expectedRunCardinality === 'one' && runCount > 1) {
    throw new EvaluationArmError(
      `arm ${arm.armId} is single-Run by construction but produced ${runCount}`,
      { armId: arm.armId });
  }
  return observedPath;
}

// Two cells may only be compared when they are genuinely different cells.
// Collapsing allocated and dynamic into one would destroy the secondary
// comparison the protocol requires.
function assertDistinctCells(armIds) {
  const unique = new Set(armIds);
  if (unique.size !== armIds.length) {
    throw new EvaluationArmError('duplicate arm cells in one comparison');
  }
  for (const [left, right] of [['A2a', 'A2b'], ['B', 'C']]) {
    if (unique.has(left) && unique.has(right)) {
      const a = ARMS[left];
      const b = ARMS[right];
      if (a.armId === b.armId || a.ownershipSource === b.ownershipSource) {
        throw new EvaluationArmError(
          `${left} and ${right} have collapsed into one cell`);
      }
    }
  }
  return true;
}

module.exports = {
  ARMS,
  ARM_IDS,
  PRODUCTION_PATHS,
  OWNERSHIP_SOURCES,
  EvaluationArmError,
  predictProductionPath,
  assertArmReachesIntendedPath,
  assertObservedPathMatches,
  assertDistinctCells
};

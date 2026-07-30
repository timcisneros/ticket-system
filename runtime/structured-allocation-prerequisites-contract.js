'use strict';

const {
  assertDeclaredWorkEvidenceConsistency,
  buildDeclaredWorkSnapshotFromFields,
  deepFreeze,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('./declared-work-contract');
const { normalizeOwnedOutputPath } = require('./allocation-plan-contract');
const { workspaceOwnershipPathsOverlap } = require('./authority-paths');

const PLANNING_AUTHORITY_SNAPSHOT_VERSION = 1;
const STRUCTURED_ALLOCATION_AUTHORITY_VERSION = 1;
const SUPPORTED_ASSIGNMENT_MODES = Object.freeze(['allocated', 'dynamic']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const INPUT_FIELDS = Object.freeze([
  'objective',
  'expectedOutputs',
  'successCriteria',
  'evidenceRequirements'
]);
const OUTPUT_INPUT_FIELDS = Object.freeze(['kind', 'declaration']);
const TEXT_CRITERION_INPUT_FIELDS = Object.freeze(['kind', 'declaration']);
const TYPED_CRITERION_INPUT_FIELDS = Object.freeze([
  'kind',
  'criterionType',
  'declaration',
  'criterionHash'
]);
const EVIDENCE_INPUT_FIELDS = Object.freeze([
  'kind',
  'criterionHash',
  'evidenceType'
]);
const GROUP_REFERENCE_FIELDS = Object.freeze(['id', 'name', 'revision']);
const PLANNER_REFERENCE_FIELDS = Object.freeze([
  'agentId',
  'name',
  'revision',
  'provider',
  'model'
]);
const CANDIDATE_REFERENCE_FIELDS = Object.freeze([
  'agentId',
  'name',
  'revision',
  'ownedOutputPaths'
]);
const PLANNING_DRAFT_FIELDS = Object.freeze([
  'version',
  'assignmentGroup',
  'planner',
  'candidates',
  'allocationMode',
  'parentDeclaredWorkHash'
]);
const PLANNING_SNAPSHOT_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'assignmentGroup',
  'planner',
  'candidates',
  'allocationMode',
  'parentDeclaredWorkHash',
  'capturedAt',
  'snapshotHash'
]);
const ELIGIBILITY_FIELDS = Object.freeze(['eligible', 'refusalReasons']);
const STRUCTURED_DRAFT_FIELDS = Object.freeze([
  'version',
  'parentDeclaredWorkSnapshot',
  'planningAuthorityDraft',
  'structuredAllocationEligibility'
]);
const STRUCTURED_AUTHORITY_FIELDS = Object.freeze([
  'version',
  'parentDeclaredWorkSnapshot',
  'planningAuthoritySnapshot',
  'structuredAllocationEligibility',
  'capturedAt',
  'authorityHash'
]);
const REFUSAL_REASON_ORDER = Object.freeze([
  'unsupported_allocation_mode',
  'missing_parent_declared_work',
  'missing_parent_expected_outputs',
  'missing_parent_success_criteria',
  'invalid_parent_declared_work',
  'missing_planner_principal',
  'planner_not_group_member',
  'planner_unavailable',
  'invalid_candidate_membership',
  'missing_owned_output_paths',
  'invalid_owned_output_paths',
  'overlapping_owned_output_paths'
]);
const STRUCTURED_ALLOCATION_REFUSAL_MESSAGES = deepFreeze({
  unsupported_allocation_mode: 'Ticket is not a supported group-owned-path allocation',
  missing_parent_declared_work: 'Ticket has no immutable parent declared-work snapshot',
  missing_parent_expected_outputs: 'Parent declared work has no explicit expected output',
  missing_parent_success_criteria: 'Parent declared work has no explicit success criterion',
  invalid_parent_declared_work: 'Parent declared work is invalid or internally inconsistent',
  missing_planner_principal: 'Assignment group has no designated planner agent',
  planner_not_group_member: 'Designated planner is not a candidate member of the assignment group',
  planner_unavailable: 'Designated planner has no valid configured provider and model route',
  invalid_candidate_membership: 'Candidate group membership is absent, duplicated, or inconsistent',
  missing_owned_output_paths: 'Every candidate agent must have explicit owned output paths',
  invalid_owned_output_paths: 'Candidate owned output paths are malformed or not canonical',
  overlapping_owned_output_paths: 'Sibling candidate owned output paths overlap'
});
const STRUCTURED_ALLOCATION_CURRENT_APPLICABILITY_MESSAGES = deepFreeze({
  historical_authority_unavailable: 'Ticket has no admitted structured-allocation authority',
  admission_ineligible: 'Ticket was not eligible for structured allocation at admission',
  assignment_changed_since_capture: 'Current ticket assignment no longer matches captured planning authority'
});

class StructuredAllocationPrerequisiteError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'StructuredAllocationPrerequisiteError';
    this.code = code;
  }
}

function fail(message, code = 'STRUCTURED_ALLOCATION_PREREQUISITE_INVALID') {
  throw new StructuredAllocationPrerequisiteError(code, message);
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
  if (unknown.length > 0) fail(`${label} contains unknown field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) fail(`${label} is missing field(s): ${missing.join(', ')}`);
}

function positiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} must be a positive safe integer`);
  return number;
}

function requiredString(value, label, maximum = 20_000) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail(`${label} must not be empty`);
  if (normalized.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return normalized;
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

function normalizeArray(value, label, normalizer, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (!allowEmpty && value.length === 0) fail(`${label} must not be empty`);
  if (value.length > 64) fail(`${label} exceeds 64 entries`);
  return value.map((item, index) => normalizer(item, index));
}

function canonicalTicketObjective(value, label = 'ticketObjective') {
  return requiredString(value, label);
}

function assertParentDeclaredWorkObjectiveMatchesTicket(
  parentDeclaredWorkSnapshot,
  ticketObjective,
  label = 'ticket objective'
) {
  const objective = canonicalTicketObjective(ticketObjective, label);
  const parent = normalizeDeclaredWorkSnapshot(parentDeclaredWorkSnapshot);
  if (parent.objective.text !== objective) {
    fail(
      'Parent declared-work objective must exactly match the canonical Ticket objective',
      'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
    );
  }
  return objective;
}

function normalizeTicketParentWorkInput(value, { ticketObjective } = {}) {
  exactFields(value, INPUT_FIELDS, 'declaredWork');
  const objective = requiredString(value.objective, 'declaredWork.objective');
  const canonicalObjective = canonicalTicketObjective(ticketObjective);
  if (objective !== canonicalObjective) {
    fail(
      'declaredWork.objective must exactly match the canonical Ticket objective',
      'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
    );
  }
  const expectedOutputs = normalizeArray(
    value.expectedOutputs,
    'declaredWork.expectedOutputs',
    (item, index) => {
      const label = `declaredWork.expectedOutputs[${index}]`;
      exactFields(item, OUTPUT_INPUT_FIELDS, label);
      return {
        kind: requiredString(item.kind, `${label}.kind`, 128),
        declaration: requiredString(item.declaration, `${label}.declaration`),
        provenance: 'ticket-authored'
      };
    }
  );
  const successCriteria = normalizeArray(
    value.successCriteria,
    'declaredWork.successCriteria',
    (item, index) => {
      const label = `declaredWork.successCriteria[${index}]`;
      if (!isPlainObject(item)) fail(`${label} must be an object`);
      if (item.kind === 'text') {
        exactFields(item, TEXT_CRITERION_INPUT_FIELDS, label);
        return {
          kind: 'text',
          declaration: requiredString(item.declaration, `${label}.declaration`),
          provenance: 'ticket-authored'
        };
      }
      exactFields(item, TYPED_CRITERION_INPUT_FIELDS, label);
      if (item.kind !== 'typed-postcondition') fail(`${label}.kind is unsupported`);
      return {
        kind: 'typed-postcondition',
        criterionType: requiredString(item.criterionType, `${label}.criterionType`, 128),
        declaration: requiredString(item.declaration, `${label}.declaration`),
        criterionHash: hash(item.criterionHash, `${label}.criterionHash`),
        provenance: 'ticket-authored'
      };
    }
  );
  const evidenceRequirements = normalizeArray(
    value.evidenceRequirements,
    'declaredWork.evidenceRequirements',
    (item, index) => {
      const label = `declaredWork.evidenceRequirements[${index}]`;
      exactFields(item, EVIDENCE_INPUT_FIELDS, label);
      if (item.kind !== 'postcondition-evidence') fail(`${label}.kind is unsupported`);
      return {
        kind: 'postcondition-evidence',
        criterionHash: hash(item.criterionHash, `${label}.criterionHash`),
        evidenceType: requiredString(item.evidenceType, `${label}.evidenceType`, 128),
        provenance: 'ticket-authored'
      };
    }
  );
  return deepFreeze({
    objective: canonicalObjective,
    expectedOutputs,
    successCriteria,
    evidenceRequirements
  });
}

function buildTicketParentDeclaredWorkSnapshot(value, { ticketObjective } = {}) {
  const input = normalizeTicketParentWorkInput(value, { ticketObjective });
  return assertDeclaredWorkEvidenceConsistency(buildDeclaredWorkSnapshotFromFields({
    objective: { text: input.objective, provenance: 'ticket-authored' },
    expectedOutputs: input.expectedOutputs,
    successCriteria: input.successCriteria,
    evidenceRequirements: input.evidenceRequirements
  }));
}

function normalizeGroupReference(value, label = 'assignmentGroup') {
  exactFields(value, GROUP_REFERENCE_FIELDS, label);
  return {
    id: positiveSafeInteger(value.id, `${label}.id`),
    name: requiredString(value.name, `${label}.name`, 512),
    revision: positiveSafeInteger(value.revision, `${label}.revision`)
  };
}

function normalizePlannerReference(value, label = 'planner') {
  exactFields(value, PLANNER_REFERENCE_FIELDS, label);
  const provider = requiredString(value.provider, `${label}.provider`, 128);
  if (!['openai', 'ollama'].includes(provider)) fail(`${label}.provider is unsupported`);
  return {
    agentId: positiveSafeInteger(value.agentId, `${label}.agentId`),
    name: requiredString(value.name, `${label}.name`, 512),
    revision: positiveSafeInteger(value.revision, `${label}.revision`),
    provider,
    model: requiredString(value.model, `${label}.model`, 512)
  };
}

function normalizeCandidateReference(value, index) {
  const label = `candidates[${index}]`;
  exactFields(value, CANDIDATE_REFERENCE_FIELDS, label);
  const ownedOutputPaths = normalizeArray(
    value.ownedOutputPaths,
    `${label}.ownedOutputPaths`,
    path => normalizeOwnedOutputPath(path),
    { allowEmpty: false }
  ).sort();
  if (new Set(ownedOutputPaths).size !== ownedOutputPaths.length) {
    fail(`${label}.ownedOutputPaths contains duplicate authority`);
  }
  return {
    agentId: positiveSafeInteger(value.agentId, `${label}.agentId`),
    name: requiredString(value.name, `${label}.name`, 512),
    revision: positiveSafeInteger(value.revision, `${label}.revision`),
    ownedOutputPaths
  };
}

function normalizeCandidates(value) {
  const candidates = normalizeArray(value, 'candidates', normalizeCandidateReference, { allowEmpty: false });
  candidates.sort((left, right) => left.agentId - right.agentId);
  if (new Set(candidates.map(candidate => candidate.agentId)).size !== candidates.length) {
    fail('candidates contains duplicate agent identities');
  }
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      for (const leftPath of candidates[leftIndex].ownedOutputPaths) {
        for (const rightPath of candidates[rightIndex].ownedOutputPaths) {
          if (workspaceOwnershipPathsOverlap(leftPath, rightPath)) {
            fail(`candidate owned output paths overlap: ${leftPath} and ${rightPath}`);
          }
        }
      }
    }
  }
  return candidates;
}

function normalizePlanningAuthorityDraft(value) {
  exactFields(value, PLANNING_DRAFT_FIELDS, 'planningAuthorityDraft');
  if (value.version !== PLANNING_AUTHORITY_SNAPSHOT_VERSION) {
    fail(`planningAuthorityDraft.version must be ${PLANNING_AUTHORITY_SNAPSHOT_VERSION}`);
  }
  const assignmentGroup = normalizeGroupReference(value.assignmentGroup, 'planningAuthorityDraft.assignmentGroup');
  const planner = normalizePlannerReference(value.planner, 'planningAuthorityDraft.planner');
  const candidates = normalizeCandidates(value.candidates);
  const allocationMode = requiredString(value.allocationMode, 'planningAuthorityDraft.allocationMode', 128);
  if (!SUPPORTED_ASSIGNMENT_MODES.includes(allocationMode)) {
    fail(`planningAuthorityDraft.allocationMode is unsupported: ${allocationMode}`);
  }
  if (!candidates.some(candidate => candidate.agentId === planner.agentId)) {
    fail('planningAuthorityDraft.planner must be a snapshotted candidate group member');
  }
  return deepFreeze({
    version: PLANNING_AUTHORITY_SNAPSHOT_VERSION,
    assignmentGroup,
    planner,
    candidates,
    allocationMode,
    parentDeclaredWorkHash: hash(
      value.parentDeclaredWorkHash,
      'planningAuthorityDraft.parentDeclaredWorkHash'
    )
  });
}

function materializePlanningAuthoritySnapshot(value, { ticketId, capturedAt }) {
  const draft = normalizePlanningAuthorityDraft(value);
  const withoutHash = {
    ...draft,
    ticketId: positiveSafeInteger(ticketId, 'planningAuthoritySnapshot.ticketId'),
    capturedAt: timestamp(capturedAt, 'planningAuthoritySnapshot.capturedAt')
  };
  return deepFreeze({ ...withoutHash, snapshotHash: hashCanonical(withoutHash) });
}

function normalizePlanningAuthoritySnapshot(value, { expectedTicketId = null } = {}) {
  exactFields(value, PLANNING_SNAPSHOT_FIELDS, 'planningAuthoritySnapshot');
  const ticketId = positiveSafeInteger(value.ticketId, 'planningAuthoritySnapshot.ticketId');
  if (expectedTicketId !== null && ticketId !== positiveSafeInteger(expectedTicketId, 'expectedTicketId')) {
    fail('planningAuthoritySnapshot.ticketId does not match its ticket authority');
  }
  const draft = normalizePlanningAuthorityDraft({
    version: value.version,
    assignmentGroup: value.assignmentGroup,
    planner: value.planner,
    candidates: value.candidates,
    allocationMode: value.allocationMode,
    parentDeclaredWorkHash: value.parentDeclaredWorkHash
  });
  const withoutHash = {
    ...draft,
    ticketId,
    capturedAt: timestamp(value.capturedAt, 'planningAuthoritySnapshot.capturedAt')
  };
  const snapshotHash = hash(value.snapshotHash, 'planningAuthoritySnapshot.snapshotHash');
  if (snapshotHash !== hashCanonical(withoutHash)) {
    fail('planningAuthoritySnapshot.snapshotHash does not match its admitted authority');
  }
  return deepFreeze({ ...withoutHash, snapshotHash });
}

function normalizeEligibility(value) {
  exactFields(value, ELIGIBILITY_FIELDS, 'structuredAllocationEligibility');
  if (typeof value.eligible !== 'boolean') fail('structuredAllocationEligibility.eligible must be boolean');
  if (!Array.isArray(value.refusalReasons)) fail('structuredAllocationEligibility.refusalReasons must be an array');
  const refusalReasons = value.refusalReasons.map((reason, index) => {
    if (!REFUSAL_REASON_ORDER.includes(reason)) {
      fail(`structuredAllocationEligibility.refusalReasons[${index}] is unsupported`);
    }
    return reason;
  });
  if (new Set(refusalReasons).size !== refusalReasons.length) {
    fail('structuredAllocationEligibility.refusalReasons contains duplicates');
  }
  refusalReasons.sort((left, right) => REFUSAL_REASON_ORDER.indexOf(left) - REFUSAL_REASON_ORDER.indexOf(right));
  if (value.eligible !== (refusalReasons.length === 0)) {
    fail('structuredAllocationEligibility.eligible conflicts with refusalReasons');
  }
  return deepFreeze({ eligible: value.eligible, refusalReasons });
}

function evaluateStructuredAllocationEligibility({
  assignmentTargetType,
  assignmentMode,
  parentDeclaredWorkSnapshot,
  assignmentGroup,
  plannerAgent,
  candidateAgents,
  ownedOutputPaths
}) {
  const reasons = new Set();
  if (assignmentTargetType !== 'group' || !SUPPORTED_ASSIGNMENT_MODES.includes(assignmentMode)) {
    reasons.add('unsupported_allocation_mode');
  }

  let parent = null;
  if (parentDeclaredWorkSnapshot == null) {
    reasons.add('missing_parent_declared_work');
  } else {
    try {
      parent = assertDeclaredWorkEvidenceConsistency(
        normalizeDeclaredWorkSnapshot(parentDeclaredWorkSnapshot)
      );
      if (parent.expectedOutputs.length === 0) reasons.add('missing_parent_expected_outputs');
      if (parent.successCriteria.length === 0) reasons.add('missing_parent_success_criteria');
    } catch (_) {
      reasons.add('invalid_parent_declared_work');
    }
  }

  const candidates = Array.isArray(candidateAgents) ? candidateAgents : [];
  const candidateIds = [];
  let normalizedCandidates = [];
  if (candidates.length === 0) {
    reasons.add('invalid_candidate_membership');
  } else {
    try {
      normalizedCandidates = candidates.map((candidate, index) => ({
        agentId: positiveSafeInteger(candidate.id, `candidateAgents[${index}].id`),
        name: requiredString(candidate.name, `candidateAgents[${index}].name`, 512),
        revision: positiveSafeInteger(candidate.revision, `candidateAgents[${index}].revision`)
      }));
      normalizedCandidates.sort((left, right) => left.agentId - right.agentId);
      candidateIds.push(...normalizedCandidates.map(candidate => candidate.agentId));
      if (new Set(candidateIds).size !== candidateIds.length) reasons.add('invalid_candidate_membership');
    } catch (_) {
      reasons.add('invalid_candidate_membership');
    }
  }

  const plannerId = assignmentGroup && assignmentGroup.plannerAgentId != null
    ? Number(assignmentGroup.plannerAgentId)
    : null;
  if (!Number.isSafeInteger(plannerId) || plannerId <= 0) {
    reasons.add('missing_planner_principal');
  } else {
    if (!candidateIds.includes(plannerId)) reasons.add('planner_not_group_member');
    if (!plannerAgent || Number(plannerAgent.id) !== plannerId ||
        !['openai', 'ollama'].includes(plannerAgent.provider) ||
        typeof plannerAgent.model !== 'string' || !plannerAgent.model.trim()) {
      reasons.add('planner_unavailable');
    }
  }

  const pathMap = isPlainObject(ownedOutputPaths) ? ownedOutputPaths : {};
  const candidateReferences = [];
  if (normalizedCandidates.length > 0) {
    for (const candidate of normalizedCandidates) {
      const rawPath = pathMap[String(candidate.agentId)] ?? pathMap[candidate.agentId];
      if (rawPath == null || rawPath === '') {
        reasons.add('missing_owned_output_paths');
        continue;
      }
      try {
        candidateReferences.push({
          ...candidate,
          ownedOutputPaths: [normalizeOwnedOutputPath(rawPath)]
        });
      } catch (_) {
        reasons.add('invalid_owned_output_paths');
      }
    }
  }
  const knownIds = new Set(candidateIds.map(String));
  if (Object.keys(pathMap).some(id => !knownIds.has(String(id)))) {
    reasons.add('invalid_candidate_membership');
  }
  if (candidateReferences.length === normalizedCandidates.length && normalizedCandidates.length > 0) {
    try {
      normalizeCandidates(candidateReferences);
    } catch (error) {
      if (/overlap/.test(error.message)) reasons.add('overlapping_owned_output_paths');
      else reasons.add('invalid_owned_output_paths');
    }
  }

  const refusalReasons = REFUSAL_REASON_ORDER.filter(reason => reasons.has(reason));
  return deepFreeze({ eligible: refusalReasons.length === 0, refusalReasons });
}

function buildStructuredAllocationAuthorityDraft({
  declaredWork,
  ticketObjective,
  assignmentTargetType,
  assignmentMode,
  assignmentGroup,
  plannerAgent,
  candidateAgents,
  ownedOutputPaths
}) {
  const parentDeclaredWorkSnapshot = buildTicketParentDeclaredWorkSnapshot(declaredWork, {
    ticketObjective
  });
  const structuredAllocationEligibility = evaluateStructuredAllocationEligibility({
    assignmentTargetType,
    assignmentMode,
    parentDeclaredWorkSnapshot,
    assignmentGroup,
    plannerAgent,
    candidateAgents,
    ownedOutputPaths
  });
  let planningAuthorityDraft = null;
  if (structuredAllocationEligibility.eligible) {
    const pathMap = ownedOutputPaths;
    planningAuthorityDraft = normalizePlanningAuthorityDraft({
      version: PLANNING_AUTHORITY_SNAPSHOT_VERSION,
      assignmentGroup: {
        id: assignmentGroup.id,
        name: assignmentGroup.name,
        revision: assignmentGroup.revision
      },
      planner: {
        agentId: plannerAgent.id,
        name: plannerAgent.name,
        revision: plannerAgent.revision,
        provider: plannerAgent.provider,
        model: plannerAgent.model
      },
      candidates: candidateAgents.map(candidate => ({
        agentId: candidate.id,
        name: candidate.name,
        revision: candidate.revision,
        ownedOutputPaths: [pathMap[String(candidate.id)] ?? pathMap[candidate.id]]
      })),
      allocationMode: assignmentMode,
      parentDeclaredWorkHash: parentDeclaredWorkSnapshot.contractHash
    });
  }
  return deepFreeze({
    version: STRUCTURED_ALLOCATION_AUTHORITY_VERSION,
    parentDeclaredWorkSnapshot,
    planningAuthorityDraft,
    structuredAllocationEligibility
  });
}

function normalizeStructuredAllocationAuthorityDraft(value) {
  exactFields(value, STRUCTURED_DRAFT_FIELDS, 'structuredAllocationAuthorityDraft');
  if (value.version !== STRUCTURED_ALLOCATION_AUTHORITY_VERSION) {
    fail(`structuredAllocationAuthorityDraft.version must be ${STRUCTURED_ALLOCATION_AUTHORITY_VERSION}`);
  }
  const parentDeclaredWorkSnapshot = assertDeclaredWorkEvidenceConsistency(
    normalizeDeclaredWorkSnapshot(value.parentDeclaredWorkSnapshot)
  );
  const structuredAllocationEligibility = normalizeEligibility(value.structuredAllocationEligibility);
  const planningAuthorityDraft = value.planningAuthorityDraft == null
    ? null
    : normalizePlanningAuthorityDraft(value.planningAuthorityDraft);
  if (structuredAllocationEligibility.eligible !== Boolean(planningAuthorityDraft)) {
    fail('structured allocation eligibility conflicts with planningAuthorityDraft presence');
  }
  if (planningAuthorityDraft && planningAuthorityDraft.parentDeclaredWorkHash !== parentDeclaredWorkSnapshot.contractHash) {
    fail('planningAuthorityDraft parent hash does not match parent declared work');
  }
  return deepFreeze({
    version: STRUCTURED_ALLOCATION_AUTHORITY_VERSION,
    parentDeclaredWorkSnapshot,
    planningAuthorityDraft,
    structuredAllocationEligibility
  });
}

function materializeStructuredAllocationAuthority(value, { ticketId, capturedAt }) {
  const draft = normalizeStructuredAllocationAuthorityDraft(value);
  const planningAuthoritySnapshot = draft.planningAuthorityDraft
    ? materializePlanningAuthoritySnapshot(draft.planningAuthorityDraft, { ticketId, capturedAt })
    : null;
  const withoutHash = {
    version: STRUCTURED_ALLOCATION_AUTHORITY_VERSION,
    parentDeclaredWorkSnapshot: draft.parentDeclaredWorkSnapshot,
    planningAuthoritySnapshot,
    structuredAllocationEligibility: draft.structuredAllocationEligibility,
    capturedAt: timestamp(capturedAt, 'structuredAllocationAuthority.capturedAt')
  };
  return deepFreeze({ ...withoutHash, authorityHash: hashCanonical(withoutHash) });
}

function normalizeStructuredAllocationAuthority(value, {
  expectedTicketId = null,
  expectedTicketObjective = null
} = {}) {
  exactFields(value, STRUCTURED_AUTHORITY_FIELDS, 'structuredAllocationAuthority');
  if (value.version !== STRUCTURED_ALLOCATION_AUTHORITY_VERSION) {
    fail(`structuredAllocationAuthority.version must be ${STRUCTURED_ALLOCATION_AUTHORITY_VERSION}`);
  }
  const parentDeclaredWorkSnapshot = assertDeclaredWorkEvidenceConsistency(
    normalizeDeclaredWorkSnapshot(value.parentDeclaredWorkSnapshot)
  );
  if (expectedTicketObjective !== null) {
    assertParentDeclaredWorkObjectiveMatchesTicket(
      parentDeclaredWorkSnapshot,
      expectedTicketObjective,
      'ticket.objective'
    );
    if (expectedTicketObjective !== parentDeclaredWorkSnapshot.objective.text) {
      fail(
        'Stored Ticket objective is not in canonical equality with parent declared work',
        'STRUCTURED_ALLOCATION_OBJECTIVE_CONFLICT'
      );
    }
  }
  const planningAuthoritySnapshot = value.planningAuthoritySnapshot == null
    ? null
    : normalizePlanningAuthoritySnapshot(value.planningAuthoritySnapshot, { expectedTicketId });
  const structuredAllocationEligibility = normalizeEligibility(value.structuredAllocationEligibility);
  if (structuredAllocationEligibility.eligible !== Boolean(planningAuthoritySnapshot)) {
    fail('structured allocation eligibility conflicts with planningAuthoritySnapshot presence');
  }
  if (planningAuthoritySnapshot &&
      planningAuthoritySnapshot.parentDeclaredWorkHash !== parentDeclaredWorkSnapshot.contractHash) {
    fail('planningAuthoritySnapshot parent hash does not match parent declared work');
  }
  const withoutHash = {
    version: STRUCTURED_ALLOCATION_AUTHORITY_VERSION,
    parentDeclaredWorkSnapshot,
    planningAuthoritySnapshot,
    structuredAllocationEligibility,
    capturedAt: timestamp(value.capturedAt, 'structuredAllocationAuthority.capturedAt')
  };
  const authorityHash = hash(value.authorityHash, 'structuredAllocationAuthority.authorityHash');
  if (authorityHash !== hashCanonical(withoutHash)) {
    fail('structuredAllocationAuthority.authorityHash does not match its admitted authority');
  }
  return deepFreeze({ ...withoutHash, authorityHash });
}

function ticketAssignmentMatchesPlanningAuthority(ticket, planningAuthority) {
  if (!ticket || !planningAuthority ||
      ticket.assignmentTargetType !== 'group' ||
      Number(ticket.assignmentTargetId) !== planningAuthority.assignmentGroup.id ||
      ticket.assignmentMode !== planningAuthority.allocationMode) {
    return false;
  }

  const currentPaths = isPlainObject(ticket.ownedOutputPaths)
    ? ticket.ownedOutputPaths
    : {};
  const expectedAgentIds = new Set(
    planningAuthority.candidates.map(candidate => String(candidate.agentId))
  );
  if (Object.keys(currentPaths).length !== expectedAgentIds.size ||
      Object.keys(currentPaths).some(agentId => !expectedAgentIds.has(String(agentId)))) {
    return false;
  }

  return planningAuthority.candidates.every(candidate => {
    const rawPath = currentPaths[String(candidate.agentId)] ?? currentPaths[candidate.agentId];
    try {
      return candidate.ownedOutputPaths.length === 1 &&
        normalizeOwnedOutputPath(rawPath) === candidate.ownedOutputPaths[0];
    } catch (_) {
      return false;
    }
  });
}

function evaluateStructuredAllocationCurrentApplicability(ticket) {
  if (!ticket || !Object.prototype.hasOwnProperty.call(ticket, 'structuredAllocationAuthority') ||
      ticket.structuredAllocationAuthority == null) {
    return deepFreeze({
      applicable: false,
      refusalReasons: ['historical_authority_unavailable']
    });
  }

  const authority = normalizeStructuredAllocationAuthority(ticket.structuredAllocationAuthority, {
    expectedTicketId: ticket.id,
    expectedTicketObjective: ticket.objective
  });
  if (!authority.structuredAllocationEligibility.eligible ||
      !authority.planningAuthoritySnapshot) {
    return deepFreeze({
      applicable: false,
      refusalReasons: ['admission_ineligible']
    });
  }

  const planning = authority.planningAuthoritySnapshot;
  return deepFreeze(ticketAssignmentMatchesPlanningAuthority(ticket, planning)
    ? { applicable: true, refusalReasons: [] }
    : { applicable: false, refusalReasons: ['assignment_changed_since_capture'] });
}

function projectStructuredAllocationAuthorityForTicket(ticket) {
  if (!ticket || !Object.prototype.hasOwnProperty.call(ticket, 'structuredAllocationAuthority') ||
      ticket.structuredAllocationAuthority == null) {
    return deepFreeze({
      availability: 'historical-unavailable',
      authority: null,
      admissionEligibility: null,
      currentApplicability: evaluateStructuredAllocationCurrentApplicability(ticket)
    });
  }
  const authority = normalizeStructuredAllocationAuthority(ticket.structuredAllocationAuthority, {
    expectedTicketId: ticket.id,
    expectedTicketObjective: ticket.objective
  });
  return deepFreeze({
    availability: 'available',
    authority,
    admissionEligibility: authority.structuredAllocationEligibility,
    currentApplicability: evaluateStructuredAllocationCurrentApplicability(ticket)
  });
}

module.exports = {
  PLANNING_AUTHORITY_SNAPSHOT_VERSION,
  STRUCTURED_ALLOCATION_AUTHORITY_VERSION,
  STRUCTURED_ALLOCATION_CURRENT_APPLICABILITY_MESSAGES,
  STRUCTURED_ALLOCATION_REFUSAL_MESSAGES,
  SUPPORTED_ASSIGNMENT_MODES,
  StructuredAllocationPrerequisiteError,
  assertParentDeclaredWorkObjectiveMatchesTicket,
  buildStructuredAllocationAuthorityDraft,
  buildTicketParentDeclaredWorkSnapshot,
  evaluateStructuredAllocationCurrentApplicability,
  evaluateStructuredAllocationEligibility,
  materializePlanningAuthoritySnapshot,
  materializeStructuredAllocationAuthority,
  normalizePlanningAuthorityDraft,
  normalizePlanningAuthoritySnapshot,
  normalizeStructuredAllocationAuthority,
  normalizeStructuredAllocationAuthorityDraft,
  normalizeTicketParentWorkInput,
  projectStructuredAllocationAuthorityForTicket,
  ticketAssignmentMatchesPlanningAuthority
};

'use strict';

const {
  DECLARED_WORK_PROVENANCE,
  DECLARED_WORK_SOURCE_PRECEDENCE,
  assertDeclaredWorkEvidenceConsistency,
  buildDeclaredWorkSnapshotFromFields,
  compareCanonicalText,
  deepFreeze,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('./declared-work-contract');
const {
  isPathInsideOwnedOutputPaths,
  normalizeWorkspaceOwnershipPath,
  normalizeWorkspaceRelativePath,
  workspaceOwnershipPathsOverlap
} = require('./authority-paths');

const ALLOCATION_PLAN_VERSION = 2;
const ALLOCATION_PLAN_MODES = Object.freeze(['owned_paths']);
const ALLOCATION_PLAN_STATUSES = Object.freeze([
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted'
]);
const ALLOCATION_ITEM_STATUSES = ALLOCATION_PLAN_STATUSES;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const AUTHORITY_FIELDS = Object.freeze([
  'version',
  'id',
  'ticketId',
  'mode',
  'parentDeclaredWorkSnapshot',
  'sharedConstraints',
  'items',
  'planHash'
]);
const BUILD_FIELDS = Object.freeze(AUTHORITY_FIELDS.filter(field => field !== 'planHash'));
const DRAFT_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'mode',
  'parentDeclaredWorkSnapshot',
  'sharedConstraints',
  'items'
]);
const ITEM_FIELDS = Object.freeze([
  'allocationItemId',
  'assignedAgentId',
  'ownedOutputPaths',
  'objective',
  'expectedOutputs',
  'successCriteria',
  'evidenceRequirements'
]);
const ITEM_DRAFT_FIELDS = Object.freeze(
  ITEM_FIELDS.filter(field => field !== 'allocationItemId')
);
const SHARED_CONSTRAINT_FIELDS = Object.freeze([
  'kind',
  'declaration',
  'provenance'
]);
const STORED_BODY_FIELDS = Object.freeze([
  'version',
  'mode',
  'parentDeclaredWorkSnapshot',
  'sharedConstraints',
  'items',
  'planHash',
  'itemStatuses'
]);
// Tranche 2B durable planning provenance. ALLOWED in a stored v2 body but not
// REQUIRED, and deliberately outside `planHash`.
//
// AUTHORITY_FIELDS is a closed required list: adding provenance there would make
// every Tranche 1 v2 plan fail exactFields on read and would change the meaning
// of every planHash already stored. Provenance therefore sits beside the
// authority, carrying its own hash and embedding the planHash it describes, so
// it verifies independently and cannot be transplanted onto another plan.
// Plans admitted before Tranche 2B, and any plan not produced by a planner,
// simply omit the field.
//
// Tranche 3 adds `aggregateDecision` on exactly the same terms: it is a durable
// EXECUTION fact derived from item-to-Run bindings and completion decisions, not
// plan authority, so it stays outside planHash and outside AUTHORITY_FIELDS. A
// plan that has not yet been reconciled simply omits it.
const STORED_BODY_OPTIONAL_FIELDS = Object.freeze([
  'planningProvenance',
  'aggregateDecision'
]);
const STORED_BODY_ALLOWED_FIELDS = Object.freeze([
  ...STORED_BODY_FIELDS,
  ...STORED_BODY_OPTIONAL_FIELDS
]);
const ITEM_STATUS_FIELDS = Object.freeze([
  'allocationItemId',
  'status',
  'createdAt'
]);

class AllocationPlanContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'AllocationPlanContractError';
    this.code = code;
  }
}

function fail(message, code = 'ALLOCATION_PLAN_V2_INVALID') {
  throw new AllocationPlanContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, allowed, required, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(field => !allowed.includes(field));
  const missing = required.filter(field =>
    !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) {
    fail(`${label} contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  if (missing.length > 0) {
    fail(`${label} is missing field(s): ${missing.join(', ')}`);
  }
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function status(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is unsupported: ${String(value)}`);
  return value;
}

function normalizePlanRelativePath(value, label, ownership) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const raw = value.trim();
  if (!raw) fail(`${label} must not be empty`);
  if (raw.includes('\0')) fail(`${label} must not contain NUL`);
  if (raw.includes('\\')) fail(`${label} must use POSIX separators`);
  const rawSegments = raw.split('/').filter(Boolean);
  if (rawSegments.some(segment => segment === '..')) {
    fail(`${label} must not escape the workspace`);
  }
  let normalized;
  try {
    normalized = normalizeWorkspaceRelativePath(raw);
  } catch (error) {
    if (error.code === 'WORKSPACE_ABSOLUTE_PATH') {
      fail(`${label} must be workspace-relative`);
    }
    if (error.code === 'WORKSPACE_PATH_TRAVERSAL') {
      fail(`${label} must not escape the workspace`);
    }
    if (error.code === 'WORKSPACE_HIDDEN_PATH') {
      fail(`${label} must not contain hidden or system path segments`);
    }
    throw error;
  }
  if (!normalized) {
    fail(`${label} must identify a workspace child path`);
  }
  return ownership ? normalizeWorkspaceOwnershipPath(normalized) : normalized;
}

function normalizeOwnedOutputPath(value, label = 'ownedOutputPath') {
  return normalizePlanRelativePath(value, label, true);
}

function normalizeExpectedOutputPath(value, label) {
  return normalizePlanRelativePath(value, label, false);
}

function pathIsInsideOwnedOutputPaths(value, ownedOutputPaths) {
  return isPathInsideOwnedOutputPaths(value, ownedOutputPaths);
}

function normalizeDeclaredWorkFields(value) {
  const snapshot = assertDeclaredWorkEvidenceConsistency(
    buildDeclaredWorkSnapshotFromFields({
      objective: value.objective,
      expectedOutputs: value.expectedOutputs,
      successCriteria: value.successCriteria,
      evidenceRequirements: value.evidenceRequirements
    })
  );
  return {
    objective: snapshot.objective,
    expectedOutputs: snapshot.expectedOutputs,
    successCriteria: snapshot.successCriteria,
    evidenceRequirements: snapshot.evidenceRequirements
  };
}

function normalizeSharedConstraints(value, parentDeclaredWorkSnapshot) {
  if (!Array.isArray(value)) fail('allocationPlan.sharedConstraints must be an array');
  value.forEach((constraint, index) => {
    exactFields(
      constraint,
      SHARED_CONSTRAINT_FIELDS,
      SHARED_CONSTRAINT_FIELDS,
      `allocationPlan.sharedConstraints[${index}]`
    );
    if (constraint.kind !== 'text') {
      fail(`allocationPlan.sharedConstraints[${index}].kind must be text`);
    }
  });
  const normalized = normalizeDeclaredWorkFields({
    objective: parentDeclaredWorkSnapshot.objective,
    expectedOutputs: [],
    successCriteria: value,
    evidenceRequirements: []
  }).successCriteria;
  if (normalized.some(item => item.kind !== 'text')) {
    fail('allocationPlan.sharedConstraints may contain only text constraints');
  }
  return normalized;
}

function provenanceRank(value) {
  const rank = DECLARED_WORK_SOURCE_PRECEDENCE.indexOf(value);
  if (rank < 0 || !DECLARED_WORK_PROVENANCE.includes(value)) {
    fail(`Unsupported declared-work provenance: ${String(value)}`);
  }
  return rank;
}

// This extracts only closed, runtime-provable vocabulary families and source
// precedence. It deliberately makes no claim that one natural-language
// declaration is a semantic subset of another.
function strongestRank(items) {
  return Math.min(...items.map(item => provenanceRank(item.provenance)));
}

function parentCapabilities(snapshot) {
  const outputKinds = new Map();
  for (const output of snapshot.expectedOutputs) {
    const ranks = outputKinds.get(output.kind) || [];
    ranks.push(provenanceRank(output.provenance));
    outputKinds.set(output.kind, ranks);
  }

  const criterionKinds = new Map();
  for (const criterion of snapshot.successCriteria) {
    const identity = criterion.kind === 'typed-postcondition'
      ? `typed-postcondition:${criterion.criterionType}`
      : criterion.kind;
    const ranks = criterionKinds.get(identity) || [];
    ranks.push(provenanceRank(criterion.provenance));
    criterionKinds.set(identity, ranks);
  }

  const evidenceKinds = new Map();
  for (const evidence of snapshot.evidenceRequirements) {
    const identity = `${evidence.kind}:${evidence.evidenceType}`;
    const ranks = evidenceKinds.get(identity) || [];
    ranks.push(provenanceRank(evidence.provenance));
    evidenceKinds.set(identity, ranks);
  }
  return { outputKinds, criterionKinds, evidenceKinds };
}

function assertSourceDoesNotBroaden(candidate, parentRanks, label) {
  if (!parentRanks || parentRanks.length === 0) {
    fail(`${label} adds authority absent from parent declared work`,
      'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
  }
  if (provenanceRank(candidate.provenance) < Math.min(...parentRanks)) {
    fail(`${label} claims stronger provenance than parent declared work`,
      'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
  }
}

function assertItemCapabilitiesWithinParent(item, capabilities, label) {
  for (const output of item.expectedOutputs) {
    assertSourceDoesNotBroaden(
      output,
      capabilities.outputKinds.get(output.kind),
      `${label}.expectedOutputs kind ${output.kind}`
    );
  }
  for (const criterion of item.successCriteria) {
    const identity = criterion.kind === 'typed-postcondition'
      ? `typed-postcondition:${criterion.criterionType}`
      : criterion.kind;
    assertSourceDoesNotBroaden(
      criterion,
      capabilities.criterionKinds.get(identity),
      `${label}.successCriteria capability ${identity}`
    );
  }
  for (const evidence of item.evidenceRequirements) {
    const identity = `${evidence.kind}:${evidence.evidenceType}`;
    assertSourceDoesNotBroaden(
      evidence,
      capabilities.evidenceKinds.get(identity),
      `${label}.evidenceRequirements capability ${identity}`
    );
  }
}

function normalizeItem(source, index, parentDeclaredWorkSnapshot, capabilities, draft) {
  const label = `allocationPlan.items[${index}]`;
  const fields = draft ? ITEM_DRAFT_FIELDS : ITEM_FIELDS;
  exactFields(source, fields, fields, label);

  const ownedSource = source.ownedOutputPaths;
  if (!Array.isArray(ownedSource) || ownedSource.length === 0) {
    fail(`${label}.ownedOutputPaths must be a non-empty array`);
  }
  const ownedOutputPaths = ownedSource
    .map((ownedPath, pathIndex) =>
      normalizeOwnedOutputPath(ownedPath, `${label}.ownedOutputPaths[${pathIndex}]`))
    .sort(compareCanonicalText);
  if (new Set(ownedOutputPaths).size !== ownedOutputPaths.length) {
    fail(`${label}.ownedOutputPaths must not contain duplicates`);
  }

  let declared = normalizeDeclaredWorkFields({
    objective: source.objective,
    expectedOutputs: source.expectedOutputs,
    successCriteria: source.successCriteria,
    evidenceRequirements: source.evidenceRequirements
  });
  const pathNormalizedOutputs = declared.expectedOutputs.map((output, outputIndex) =>
    output.kind === 'workflow-artifact'
      ? {
          ...output,
          declaration: normalizeExpectedOutputPath(
            output.declaration,
            `${label}.expectedOutputs[${outputIndex}].declaration`
          )
        }
      : output);
  declared = normalizeDeclaredWorkFields({
    ...declared,
    expectedOutputs: pathNormalizedOutputs
  });

  if (declared.expectedOutputs.length === 0) {
    fail(`${label}.expectedOutputs must contain at least one explicit declaration`);
  }
  if (declared.successCriteria.length === 0) {
    fail(`${label}.successCriteria must contain at least one explicit declaration`);
  }
  for (const [outputIndex, output] of declared.expectedOutputs.entries()) {
    if (output.kind !== 'workflow-artifact') continue;
    if (!pathIsInsideOwnedOutputPaths(output.declaration, ownedOutputPaths)) {
      fail(
        `${label}.expectedOutputs[${outputIndex}] lies outside owned output paths`,
        'ALLOCATION_PLAN_V2_OUTPUT_OUTSIDE_OWNERSHIP'
      );
    }
  }

  const parentObjectiveRank = provenanceRank(parentDeclaredWorkSnapshot.objective.provenance);
  if (provenanceRank(declared.objective.provenance) < parentObjectiveRank) {
    fail(`${label}.objective claims stronger provenance than parent declared work`,
      'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION');
  }

  const item = {
    ...(draft ? {} : {
      allocationItemId: positiveSafeInteger(
        source.allocationItemId,
        `${label}.allocationItemId`
      )
    }),
    assignedAgentId: positiveSafeInteger(
      source.assignedAgentId,
      `${label}.assignedAgentId`
    ),
    ownedOutputPaths,
    objective: declared.objective,
    expectedOutputs: declared.expectedOutputs,
    successCriteria: declared.successCriteria,
    evidenceRequirements: declared.evidenceRequirements
  };
  assertItemCapabilitiesWithinParent(item, capabilities, label);
  return item;
}

function assertNoSiblingOwnedPathOverlap(items) {
  const owners = items.flatMap(item => item.ownedOutputPaths.map(ownedPath => ({
    allocationItemId: item.allocationItemId,
    assignedAgentId: item.assignedAgentId,
    ownedPath
  })));
  for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
      const left = owners[leftIndex];
      const right = owners[rightIndex];
      if (left.allocationItemId === right.allocationItemId) continue;
      if (workspaceOwnershipPathsOverlap(left.ownedPath, right.ownedPath)) {
        fail(
          `Sibling owned output paths overlap: ${left.ownedPath} and ${right.ownedPath}`,
          'ALLOCATION_PLAN_V2_OWNERSHIP_OVERLAP'
        );
      }
    }
  }
}

function normalizePlanCore(source, draft = false) {
  const allowed = draft ? DRAFT_FIELDS : BUILD_FIELDS;
  exactFields(source, allowed, allowed, 'allocationPlan');
  if (source.version !== ALLOCATION_PLAN_VERSION) {
    fail(`Unsupported allocation plan version: ${String(source.version)}`);
  }
  const mode = source.mode;
  if (!ALLOCATION_PLAN_MODES.includes(mode)) {
    fail(`allocationPlan.mode is unsupported: ${String(mode)}`);
  }
  const parentDeclaredWorkSnapshot =
    normalizeDeclaredWorkSnapshot(source.parentDeclaredWorkSnapshot);
  const capabilities = parentCapabilities(parentDeclaredWorkSnapshot);
  const sharedConstraints =
    normalizeSharedConstraints(source.sharedConstraints, parentDeclaredWorkSnapshot);
  if (sharedConstraints.length > 0) {
    const parentRanks = [
      parentDeclaredWorkSnapshot.objective,
      ...parentDeclaredWorkSnapshot.expectedOutputs,
      ...parentDeclaredWorkSnapshot.successCriteria,
      ...parentDeclaredWorkSnapshot.evidenceRequirements
    ];
    const strongestParentRank = strongestRank(parentRanks);
    // Shared constraints are closed text declarations, so this check can limit
    // source strength but cannot grant any capability or operation family.
    for (const [index, constraint] of sharedConstraints.entries()) {
      if (provenanceRank(constraint.provenance) < strongestParentRank) {
        fail(
          `allocationPlan.sharedConstraints[${index}] claims stronger provenance than parent authority`,
          'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION'
        );
      }
    }
  }

  if (!Array.isArray(source.items) || source.items.length === 0) {
    fail('allocationPlan.items must be a non-empty array');
  }
  const items = source.items
    .map((item, index) =>
      normalizeItem(item, index, parentDeclaredWorkSnapshot, capabilities, draft))
    .sort((left, right) => draft
      ? left.assignedAgentId - right.assignedAgentId
      : left.allocationItemId - right.allocationItemId);

  const agentIds = items.map(item => item.assignedAgentId);
  if (new Set(agentIds).size !== agentIds.length) {
    fail('allocationPlan.items must assign each agent at most once');
  }
  if (!draft) {
    const itemIds = items.map(item => item.allocationItemId);
    if (new Set(itemIds).size !== itemIds.length) {
      fail('allocationPlan.items must use unique allocationItemId values');
    }
    assertNoSiblingOwnedPathOverlap(items);
  } else {
    assertNoSiblingOwnedPathOverlap(items.map((item, index) => ({
      ...item,
      allocationItemId: index + 1
    })));
  }

  return {
    version: ALLOCATION_PLAN_VERSION,
    ...(draft ? {} : { id: positiveSafeInteger(source.id, 'allocationPlan.id') }),
    ticketId: positiveSafeInteger(source.ticketId, 'allocationPlan.ticketId'),
    mode,
    parentDeclaredWorkSnapshot,
    sharedConstraints,
    items
  };
}

function buildAllocationPlanV2(value) {
  const withoutHash = normalizePlanCore(value);
  return deepFreeze({
    ...withoutHash,
    planHash: hashCanonical(withoutHash)
  });
}

function normalizeAllocationPlanV2(value) {
  exactFields(value, AUTHORITY_FIELDS, AUTHORITY_FIELDS, 'allocationPlan');
  const suppliedHash = hash(value.planHash, 'allocationPlan.planHash');
  const buildInput = Object.fromEntries(
    BUILD_FIELDS.map(field => [field, value[field]])
  );
  const normalized = buildAllocationPlanV2(buildInput);
  if (suppliedHash !== normalized.planHash) {
    fail(
      'allocationPlan.planHash does not match its immutable authority',
      'ALLOCATION_PLAN_V2_HASH_MISMATCH'
    );
  }
  return normalized;
}

function materializeAllocationPlanV2Draft(value, identities) {
  const draft = normalizePlanCore(value, true);
  exactFields(identities, ['id', 'allocationItemIds'], ['id', 'allocationItemIds'],
    'allocationPlan.identities');
  if (!Array.isArray(identities.allocationItemIds) ||
      identities.allocationItemIds.length !== draft.items.length) {
    fail('allocationPlan.identities.allocationItemIds must match the item count');
  }
  return buildAllocationPlanV2({
    ...draft,
    id: positiveSafeInteger(identities.id, 'allocationPlan.identities.id'),
    items: draft.items.map((item, index) => ({
      ...item,
      allocationItemId: positiveSafeInteger(
        identities.allocationItemIds[index],
        `allocationPlan.identities.allocationItemIds[${index}]`
      )
    }))
  });
}

function normalizeItemStatuses(value, items) {
  if (!Array.isArray(value)) fail('allocationPlan.itemStatuses must be an array');
  const normalized = value.map((itemStatus, index) => {
    const label = `allocationPlan.itemStatuses[${index}]`;
    exactFields(itemStatus, ITEM_STATUS_FIELDS, ITEM_STATUS_FIELDS, label);
    return {
      allocationItemId: positiveSafeInteger(
        itemStatus.allocationItemId,
        `${label}.allocationItemId`
      ),
      status: status(itemStatus.status, ALLOCATION_ITEM_STATUSES, `${label}.status`),
      createdAt: timestamp(itemStatus.createdAt, `${label}.createdAt`)
    };
  }).sort((left, right) => left.allocationItemId - right.allocationItemId);
  const expectedIds = items.map(item => item.allocationItemId);
  const actualIds = normalized.map(item => item.allocationItemId);
  if (new Set(actualIds).size !== actualIds.length ||
      expectedIds.length !== actualIds.length ||
      expectedIds.some((id, index) => id !== actualIds[index])) {
    fail('allocationPlan.itemStatuses must identify every allocation item exactly once');
  }
  return normalized;
}

function createAllocationPlanV2StorageBody(authorityValue, createdAt, planningProvenance = null) {
  const authority = normalizeAllocationPlanV2(authorityValue);
  const itemStatuses = authority.items.map(item => ({
    allocationItemId: item.allocationItemId,
    status: 'pending',
    createdAt: timestamp(createdAt, 'allocationPlan.createdAt')
  }));
  return deepFreeze({
    version: authority.version,
    mode: authority.mode,
    parentDeclaredWorkSnapshot: authority.parentDeclaredWorkSnapshot,
    sharedConstraints: authority.sharedConstraints,
    items: authority.items,
    planHash: authority.planHash,
    itemStatuses,
    ...(planningProvenance === null ? {} : { planningProvenance })
  });
}

function authorityFromV2Projection(value) {
  return normalizeAllocationPlanV2({
    version: value.version,
    id: value.id,
    ticketId: value.ticketId,
    mode: value.mode,
    parentDeclaredWorkSnapshot: value.parentDeclaredWorkSnapshot,
    sharedConstraints: value.sharedConstraints,
    items: value.items.map(item => Object.fromEntries(
      ITEM_FIELDS.map(field => [field, item[field]])
    )),
    planHash: value.planHash
  });
}

// Status writes re-serialize the whole body, so provenance is carried forward
// explicitly here. Dropping it would let an ordinary item-status update erase
// durable admission evidence.
function serializeAllocationPlanV2StorageBody(
  value,
  itemStatusesValue = value.itemStatuses,
  { aggregateDecision = value.aggregateDecision } = {}
) {
  const authority = authorityFromV2Projection(value);
  const itemStatuses = normalizeItemStatuses(itemStatusesValue, authority.items);
  return deepFreeze({
    version: authority.version,
    mode: authority.mode,
    parentDeclaredWorkSnapshot: authority.parentDeclaredWorkSnapshot,
    sharedConstraints: authority.sharedConstraints,
    items: authority.items,
    planHash: authority.planHash,
    itemStatuses,
    ...(value.planningProvenance == null
      ? {}
      : { planningProvenance: value.planningProvenance }),
    ...(aggregateDecision == null ? {} : { aggregateDecision })
  });
}

function normalizeStoredAllocationPlanV2({
  id,
  ticketId,
  status: planStatus,
  revision,
  createdAt,
  updatedAt,
  body
}) {
  exactFields(body, STORED_BODY_ALLOWED_FIELDS, STORED_BODY_FIELDS, 'allocationPlan.body');
  const authority = normalizeAllocationPlanV2({
    version: body.version,
    id,
    ticketId,
    mode: body.mode,
    parentDeclaredWorkSnapshot: body.parentDeclaredWorkSnapshot,
    sharedConstraints: body.sharedConstraints,
    items: body.items,
    planHash: body.planHash
  });
  const itemStatuses = normalizeItemStatuses(body.itemStatuses, authority.items);
  const statusById = new Map(itemStatuses.map(item => [item.allocationItemId, item]));
  return deepFreeze({
    ...authority,
    ...(Object.prototype.hasOwnProperty.call(body, 'planningProvenance')
      ? { planningProvenance: body.planningProvenance }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'aggregateDecision')
      ? { aggregateDecision: body.aggregateDecision }
      : {}),
    status: status(planStatus, ALLOCATION_PLAN_STATUSES, 'allocationPlan.status'),
    items: authority.items.map(item => ({
      ...item,
      ...statusById.get(item.allocationItemId)
    })),
    itemStatuses,
    revision: positiveSafeInteger(revision, 'allocationPlan.revision'),
    createdAt: timestamp(createdAt, 'allocationPlan.createdAt'),
    updatedAt: timestamp(updatedAt, 'allocationPlan.updatedAt')
  });
}

module.exports = {
  ALLOCATION_ITEM_STATUSES,
  ALLOCATION_PLAN_MODES,
  ALLOCATION_PLAN_STATUSES,
  ALLOCATION_PLAN_VERSION,
  AllocationPlanContractError,
  buildAllocationPlanV2,
  createAllocationPlanV2StorageBody,
  materializeAllocationPlanV2Draft,
  normalizeAllocationPlanV2,
  normalizeOwnedOutputPath,
  normalizeStoredAllocationPlanV2,
  pathIsInsideOwnedOutputPaths,
  serializeAllocationPlanV2StorageBody,
  STORED_BODY_ALLOWED_FIELDS,
  STORED_BODY_OPTIONAL_FIELDS
};

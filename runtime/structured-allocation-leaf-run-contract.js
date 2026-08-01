'use strict';

// Tranche 3 — leaf-run admission and aggregate completion.
//
// This module turns an admitted, pending Allocation Plan v2 into leaf-run
// authority, and turns durable per-Run completion decisions back into a
// deterministic aggregate plan decision. It performs no I/O and calls no model:
// every value here is a pure function of already-admitted authority plus
// runtime-assigned Run identity and persisted Run facts.
//
// It deliberately adds no execution engine, no scheduler, no routing policy and
// no new product primitive. A leaf Run is an ordinary Run; the only new thing is
// the immutable binding proving WHICH allocation item it executes and that the
// binding cannot be transplanted, rebuilt from mutable state, or duplicated.
//
// It also deliberately does NOT decide the parent Ticket status. That rule
// already exists exactly once, in transitionTicketAfterRun(), which projects
// every run in the batch through its durable completion decision and owns the
// completed/failed/blocked/interrupted mapping including the owned-scope
// "every sibling completed" rule. Restating it here would create a second
// parent-completion authority that could disagree with the canonical one.

const {
  assertDeclaredWorkEvidenceConsistency,
  buildDeclaredWorkSnapshot,
  buildDeclaredWorkSnapshotFromFields,
  canonicalJson,
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const {
  ALLOCATION_ITEM_STATUSES,
  normalizeOwnedOutputPath
} = require('./allocation-plan-contract');
const { COMPLETION_DISPOSITIONS } = require('./completion-decision-contract');

const LEAF_RUN_BINDING_VERSION = 1;
const AGGREGATE_PLAN_DECISION_VERSION = 1;

// Reused verbatim from the allocation-plan contract. Tranche 3 invents no
// status: pending/running/completed/failed/interrupted already express every
// truthful leaf and plan state this tranche can reach, and the durable item
// status is written back into exactly this vocabulary.
//
// There is deliberately no item-level `blocked`: ALLOCATION_ITEM_STATUSES has
// never contained one. A blocked completion disposition therefore resolves to a
// failed ITEM, while the parent Ticket still reaches `blocked` through
// transitionTicketAfterRun, which reads the same durable decision directly.
const LEAF_ITEM_STATUSES = ALLOCATION_ITEM_STATUSES;
const NONTERMINAL_RUN_STATUSES = Object.freeze(['pending', 'running']);
const TERMINAL_RUN_STATUSES = Object.freeze(['completed', 'failed', 'interrupted']);

// Closed refusal vocabulary for leaf admission. Every path that declines names
// exactly one of these; no free-form text becomes a reason code.
const LEAF_ADMISSION_REFUSALS = Object.freeze([
  'historical_authority_unavailable',
  'admission_ineligible',
  'assignment_changed_since_capture',
  'planning_attempt_not_admitted',
  'admitted_plan_missing',
  'admitted_plan_mismatch',
  'plan_not_pending',
  'plan_provenance_missing',
  'plan_admission_binding_invalid',
  'leaf_runs_already_exist',
  'leaf_admission_already_performed',
  'leaf_item_typed_criteria_unsupported',
  'leaf_agent_missing',
  'leaf_agent_not_authorized',
  'leaf_ownership_drift',
  'leaf_route_refused',
  'leaf_execution_mode_unsupported',
  'leaf_admission_conflict'
]);

const LEAF_ADMISSION_MESSAGES = deepFreeze({
  historical_authority_unavailable: 'Ticket has no admitted structured-allocation authority',
  admission_ineligible: 'Ticket was not eligible for structured allocation at admission',
  assignment_changed_since_capture: 'Current ticket assignment no longer matches captured planning authority',
  planning_attempt_not_admitted: 'No planning attempt has admitted an allocation plan for this ticket',
  admitted_plan_missing: 'The admitted allocation plan no longer exists',
  admitted_plan_mismatch: 'The stored plan does not match the identity or hash the attempt admitted',
  plan_not_pending: 'The allocation plan is no longer pending leaf admission',
  plan_provenance_missing: 'The allocation plan carries no planner provenance',
  plan_admission_binding_invalid: 'The allocation plan admission binding does not verify',
  leaf_runs_already_exist: 'Worker runs already exist for this ticket',
  leaf_admission_already_performed: 'Leaf-run admission has already been performed for this plan',
  // Model-proposed typed criteria carry `validated-model-contract` provenance,
  // which declared-work-contract admits no completion authority for: see
  // assertDeclaredWorkCompletionAuthorityBinding, which accepts only
  // `workflow-defined` and `deterministic-objective-contract` typed criteria and
  // additionally requires the run's immutable completion authority to contain
  // exactly the same criterion set. A per-item subset of parent authority can
  // therefore never bind either. Granting one would be an authority decision,
  // not a lowering decision, so this tranche refuses the whole admission.
  leaf_item_typed_criteria_unsupported:
    'Allocation item declares a typed criterion with no admitted completion authority',
  leaf_agent_missing: 'An allocation item assigned agent no longer exists',
  leaf_agent_not_authorized: 'An allocation item assigned agent is no longer authorized through the group',
  leaf_ownership_drift: 'Allocation item ownership no longer matches its admitted authority',
  leaf_route_refused: 'No admitted model route is available for an allocation item assigned agent',
  // Workflow leaves would have to carry workflow-defined typed criteria and the
  // workflow verification contract onto every item. The allocation plan admits
  // neither, so this tranche refuses rather than synthesising them.
  leaf_execution_mode_unsupported:
    'Structured leaf-run admission supports agent execution only',
  leaf_admission_conflict: 'Leaf-run admission lost a concurrent race for this allocation plan'
});

// Why an item holds the durable status it holds. Closed, so a projection can
// explain an unresolved item without any free-form runtime prose.
const LEAF_ITEM_DISPOSITION_REASONS = Object.freeze([
  'run_nonterminal',
  'completion_verified',
  'completion_blocked',
  'completion_unsuccessful',
  'completion_decision_missing',
  'completion_decision_stale',
  'completion_decision_conflicts_run',
  'completion_authority_mismatch',
  'declared_work_mismatch',
  'run_terminal_without_authority'
]);

const LEAF_RUN_BINDING_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'allocationPlanId',
  'planHash',
  'allocationItemId',
  'assignedAgentId',
  'itemDeclaredWorkHash',
  'ownedOutputPaths',
  'parentDeclaredWorkHash',
  'planningAttemptId',
  'planningAdmissionHash',
  'runId',
  'admittedAt',
  'bindingHash'
]);

const AGGREGATE_ITEM_FIELDS = Object.freeze([
  'allocationItemId',
  'assignedAgentId',
  'runId',
  'runLineage',
  'itemStatus',
  'completionDecisionHash',
  'reason'
]);

const AGGREGATE_DECISION_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'allocationPlanId',
  'planHash',
  'planningAdmissionHash',
  'items',
  'completedItemIds',
  'failedItemIds',
  'interruptedItemIds',
  'unresolvedItemIds',
  'aggregateStatus',
  'decidedAt',
  'decisionHash'
]);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class StructuredAllocationLeafRunError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'StructuredAllocationLeafRunError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'STRUCTURED_ALLOCATION_LEAF_RUN_INVALID', detail = {}) {
  throw new StructuredAllocationLeafRunError(code, message, detail);
}

// The refusal vocabulary is closed on the way OUT as well as on the way in: a
// misspelled reason cannot become a refusal code that no caller can match.
function refuse(reason, message = null) {
  if (!LEAF_ADMISSION_REFUSALS.includes(reason)) {
    fail(`Unsupported leaf-admission refusal reason: ${String(reason)}`);
  }
  fail(message || LEAF_ADMISSION_MESSAGES[reason],
    'STRUCTURED_ALLOCATION_LEAF_ADMISSION_REFUSED', { reason });
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

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nullableHash(value, label) {
  return value === null ? null : hash(value, label);
}

function attemptIdentity(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a lowercase UUID`);
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

// ── Item declared work → Run declared work ──────────────────────────────────
//
// The item declaration IS the leaf execution declaration. It is projected
// through the canonical declared-work builder rather than a second schema, so a
// leaf Run's declared work is indistinguishable in kind from any other Run's.
//
// The parent Ticket declaration remains superior parent authority and is bound
// separately by `parentDeclaredWorkHash` on the binding; it is never merged into
// the leaf declaration, and the generic v1 `allocationSubtask` never appears.

// Preflight, and the only place a typed criterion is judged. It runs over EVERY
// item before any Run identity is reserved so a single unsupported criterion
// refuses the whole atomic admission rather than admitting text-only siblings.
function assertLeafItemCompletionAuthoritySupported(item, label = null) {
  const itemLabel = label || `allocationItem[${item.allocationItemId}]`;
  if (!Array.isArray(item.successCriteria)) {
    fail(`${itemLabel}.successCriteria must be an array`);
  }
  for (const criterion of item.successCriteria) {
    if (criterion.kind !== 'typed-postcondition') continue;
    refuse('leaf_item_typed_criteria_unsupported',
      `${itemLabel} declares a typed criterion (${criterion.criterionType}) with ` +
      `${criterion.provenance} provenance, which has no admitted completion authority`);
  }
  return item;
}

// Shared plan constraints are plan-level authority that applies to every item,
// so they are carried onto each leaf exactly as the plan admitted them rather
// than re-derived or dropped. They are deduplicated by canonical identity first:
// normalizeArray() in declared-work-contract REJECTS duplicate declarations, and
// a planner may legitimately restate a shared constraint inside an item.
//
// `completionAuthoritySnapshot` is the leaf Run's own immutable completion
// authority. Its deterministic postconditions are projected through the SAME
// canonical builder every other Run uses, so the leaf declaration satisfies
// assertDeclaredWorkCompletionAuthorityBinding, which requires declared typed
// criteria and admitted completion criteria to be exactly the same set in both
// directions. Nothing about that derivation is invented here: only the item
// supplies content, and only the runtime supplies typed authority.
function buildLeafDeclaredWorkSnapshot(item, {
  sharedConstraints = [],
  completionAuthoritySnapshot = null
} = {}) {
  const label = `allocationItem[${item.allocationItemId}]`;
  assertLeafItemCompletionAuthoritySupported(item, label);
  if (!Array.isArray(sharedConstraints)) {
    fail('leafDeclaredWork.sharedConstraints must be an array');
  }
  const merged = new Map();
  for (const criterion of item.successCriteria) {
    merged.set(canonicalJson(criterion), criterion);
  }
  sharedConstraints.forEach((constraint, index) => {
    if (!isPlainObject(constraint) || constraint.kind !== 'text') {
      fail(`leafDeclaredWork.sharedConstraints[${index}] must be a text constraint`);
    }
    const carried = {
      kind: 'text',
      declaration: constraint.declaration,
      provenance: constraint.provenance
    };
    const identity = canonicalJson(carried);
    if (!merged.has(identity)) merged.set(identity, carried);
  });
  // Delegated rather than reimplemented: buildDeclaredWorkSnapshot already owns
  // postcondition normalization, criterion identity, hashing and the one
  // evidence requirement per typed criterion. Only its typed output is taken;
  // the objective and its model provenance stay the item's.
  const runtimeTyped = completionAuthoritySnapshot === null
    ? { successCriteria: [], evidenceRequirements: [] }
    : buildDeclaredWorkSnapshot({
      ticket: { objective: item.objective.text },
      workflow: null,
      completionAuthoritySnapshot
    });
  for (const criterion of runtimeTyped.successCriteria) {
    if (criterion.kind !== 'typed-postcondition') continue;
    merged.set(canonicalJson(criterion), criterion);
  }
  const evidence = new Map();
  for (const requirement of [...item.evidenceRequirements, ...runtimeTyped.evidenceRequirements]) {
    evidence.set(canonicalJson(requirement), requirement);
  }
  return assertDeclaredWorkEvidenceConsistency(buildDeclaredWorkSnapshotFromFields({
    objective: item.objective,
    expectedOutputs: item.expectedOutputs,
    successCriteria: [...merged.values()],
    evidenceRequirements: [...evidence.values()]
  }));
}

// ── Leaf-run binding ────────────────────────────────────────────────────────
//
// One allocation item ↔ one initial leaf Run. The binding carries the plan
// hash, the item's declared-work hash and the plan's admission binding, so it
// cannot be transplanted onto another Ticket, plan, item or Run, and cannot be
// reconstructed from current group/agent/route configuration.

function buildLeafRunBinding({
  ticketId,
  allocationPlanId,
  planHash,
  allocationItemId,
  assignedAgentId,
  itemDeclaredWorkHash,
  ownedOutputPaths,
  parentDeclaredWorkHash,
  planningAttemptId,
  planningAdmissionHash,
  runId,
  admittedAt
}) {
  if (!Array.isArray(ownedOutputPaths)) {
    fail('leafRunBinding.ownedOutputPaths must be an array');
  }
  const paths = ownedOutputPaths
    .map((ownedPath, index) =>
      normalizeOwnedOutputPath(ownedPath, `leafRunBinding.ownedOutputPaths[${index}]`))
    .sort(compareCanonicalText);
  if (paths.length === 0) fail('leafRunBinding.ownedOutputPaths must be non-empty');
  if (new Set(paths).size !== paths.length) {
    fail('leafRunBinding.ownedOutputPaths must not contain duplicates');
  }
  const withoutHash = {
    version: LEAF_RUN_BINDING_VERSION,
    ticketId: positiveSafeInteger(ticketId, 'leafRunBinding.ticketId'),
    allocationPlanId: positiveSafeInteger(allocationPlanId, 'leafRunBinding.allocationPlanId'),
    planHash: hash(planHash, 'leafRunBinding.planHash'),
    allocationItemId: positiveSafeInteger(allocationItemId, 'leafRunBinding.allocationItemId'),
    assignedAgentId: positiveSafeInteger(assignedAgentId, 'leafRunBinding.assignedAgentId'),
    itemDeclaredWorkHash: hash(itemDeclaredWorkHash, 'leafRunBinding.itemDeclaredWorkHash'),
    ownedOutputPaths: paths,
    parentDeclaredWorkHash: hash(parentDeclaredWorkHash, 'leafRunBinding.parentDeclaredWorkHash'),
    planningAttemptId: attemptIdentity(planningAttemptId, 'leafRunBinding.planningAttemptId'),
    planningAdmissionHash: hash(planningAdmissionHash, 'leafRunBinding.planningAdmissionHash'),
    runId: positiveSafeInteger(runId, 'leafRunBinding.runId'),
    admittedAt: timestamp(admittedAt, 'leafRunBinding.admittedAt')
  };
  return deepFreeze({ ...withoutHash, bindingHash: hashCanonical(withoutHash) });
}

function normalizeLeafRunBinding(value, {
  expectedRunId = null,
  expectedTicketId = null,
  expectedPlanId = null,
  expectedPlanHash = null,
  expectedAllocationItemId = null
} = {}) {
  // exactFields requires every field, so a partial binding cannot be represented.
  exactFields(value, LEAF_RUN_BINDING_FIELDS, 'leafRunBinding');
  if (value.version !== LEAF_RUN_BINDING_VERSION) {
    fail(`leafRunBinding.version must be ${LEAF_RUN_BINDING_VERSION}`);
  }
  const rebuilt = buildLeafRunBinding(value);
  const bindingHash = hash(value.bindingHash, 'leafRunBinding.bindingHash');
  if (bindingHash !== rebuilt.bindingHash) {
    fail('leafRunBinding.bindingHash does not match its admitted authority');
  }
  const expectations = [
    ['runId', expectedRunId, 'does not identify its run'],
    ['ticketId', expectedTicketId, 'does not identify its ticket'],
    ['allocationPlanId', expectedPlanId, 'does not identify its allocation plan'],
    ['allocationItemId', expectedAllocationItemId, 'does not identify its allocation item']
  ];
  for (const [field, expected, message] of expectations) {
    if (expected === null) continue;
    if (rebuilt[field] !== positiveSafeInteger(expected, `expected.${field}`)) {
      fail(`leafRunBinding.${field} ${message}`);
    }
  }
  if (expectedPlanHash !== null &&
      rebuilt.planHash !== hash(expectedPlanHash, 'expected.planHash')) {
    fail('leafRunBinding.planHash does not identify its allocation plan authority');
  }
  return rebuilt;
}

// A binding is only authority if it still agrees with the immutable item it
// claims. Item identity alone is not enough: agent, ownership and declared-work
// identity are all re-derived from the plan item and compared.
function assertLeafBindingMatchesItem(binding, item, declaredWorkHash = null) {
  if (binding.assignedAgentId !== item.assignedAgentId) {
    fail(`Leaf binding for item ${item.allocationItemId} names a different assigned agent`,
      'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
  }
  const itemPaths = [...item.ownedOutputPaths].sort(compareCanonicalText);
  if (binding.ownedOutputPaths.length !== itemPaths.length ||
      binding.ownedOutputPaths.some((ownedPath, index) => ownedPath !== itemPaths[index])) {
    fail(`Leaf binding for item ${item.allocationItemId} does not carry its admitted ownership`,
      'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
  }
  if (declaredWorkHash !== null &&
      binding.itemDeclaredWorkHash !== hash(declaredWorkHash, 'itemDeclaredWorkHash')) {
    fail(`Leaf binding for item ${item.allocationItemId} does not carry its declared work`,
      'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
  }
  return binding;
}

// Every admitted item exactly once, every binding pointing at this plan, no
// duplicate item and no reused Run. This is the one-to-one integrity check; the
// store applies it under the Ticket lock so concurrent admission cannot
// interleave, and a partially persisted leaf set is reported as an integrity
// defect instead of being completed from mutable configuration.
// `declaredWorkHashByItemId` is supplied by the caller that knows each leaf
// Run's own completion authority — the declared-work identity depends on it, so
// the plan alone cannot re-derive it. When supplied it is the strongest check
// available: the binding must carry exactly the declared work the Run holds.
// When omitted, agent, ownership, coverage and Run uniqueness are still checked.
function assertLeafBindingSetComplete(bindings, plan, {
  declaredWorkHashByItemId = null
} = {}) {
  if (!Array.isArray(bindings)) fail('leafRunBindings must be an array');
  const itemsById = new Map(plan.items.map(item => [item.allocationItemId, item]));
  const normalized = bindings.map(binding => {
    const candidate = normalizeLeafRunBinding(binding, {
      expectedTicketId: plan.ticketId,
      expectedPlanId: plan.id,
      expectedPlanHash: plan.planHash
    });
    const item = itemsById.get(candidate.allocationItemId);
    if (!item) {
      fail(`Leaf binding names allocation item ${candidate.allocationItemId}, ` +
        'which this plan does not contain',
        'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
    }
    if (candidate.parentDeclaredWorkHash !== plan.parentDeclaredWorkSnapshot.contractHash) {
      fail(`Leaf binding for item ${item.allocationItemId} does not carry the admitted parent work`,
        'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
    }
    const declaredWorkHash = declaredWorkHashByItemId === null
      ? null
      : (declaredWorkHashByItemId.get(candidate.allocationItemId) || null);
    if (declaredWorkHashByItemId !== null && declaredWorkHash === null) {
      fail(`Leaf binding for item ${item.allocationItemId} has no declared work to compare`,
        'STRUCTURED_ALLOCATION_LEAF_BINDING_CONFLICT');
    }
    return assertLeafBindingMatchesItem(candidate, item, declaredWorkHash);
  });
  const itemIds = normalized.map(binding => binding.allocationItemId).sort((a, b) => a - b);
  const expectedIds = plan.items.map(item => item.allocationItemId).sort((a, b) => a - b);
  if (itemIds.length !== expectedIds.length ||
      itemIds.some((id, index) => id !== expectedIds[index])) {
    fail('Leaf bindings must cover every allocation item exactly once',
      'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE');
  }
  if (new Set(normalized.map(binding => binding.runId)).size !== normalized.length) {
    fail('Leaf bindings must not reuse a run identity',
      'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE');
  }
  return deepFreeze(normalized.sort((left, right) =>
    left.allocationItemId - right.allocationItemId));
}

// ── Per-item durable disposition ────────────────────────────────────────────
//
// A leaf item is complete only when its bound Run carries a durable completion
// decision that identifies that exact Run, was evaluated against that Run's
// completion authority, and reports disposition `completed`. A terminal Run
// status is NOT the item outcome: `run.status` can be `completed` while the
// decision is absent, stale, conflicting or unsuccessful, which is precisely
// the conflation this rule exists to prevent.
//
// It is total. Every reachable combination yields a status in the existing
// vocabulary and a closed reason, so repeated reconciliation is deterministic
// and idempotent instead of throwing on an already-observed integrity gap.

function leafItemDisposition(allocationItemId, runId, itemStatus, completionDecisionHash, reason) {
  return deepFreeze({
    allocationItemId: positiveSafeInteger(allocationItemId, 'leafItemDisposition.allocationItemId'),
    runId: runId === null ? null : positiveSafeInteger(runId, 'leafItemDisposition.runId'),
    itemStatus: enumerated(itemStatus, LEAF_ITEM_STATUSES, 'leafItemDisposition.itemStatus'),
    completionDecisionHash: nullableHash(
      completionDecisionHash,
      'leafItemDisposition.completionDecisionHash'
    ),
    reason: enumerated(reason, LEAF_ITEM_DISPOSITION_REASONS, 'leafItemDisposition.reason')
  });
}

function deriveLeafItemDisposition({
  binding,
  runId,
  runTicketId,
  runStatus,
  runDeclaredWorkHash,
  runCompletionAuthorityHash,
  decision = null
}) {
  const bound = normalizeLeafRunBinding(binding, {
    expectedRunId: runId,
    expectedTicketId: runTicketId
  });
  const item = bound.allocationItemId;
  const status = enumerated(
    runStatus,
    [...NONTERMINAL_RUN_STATUSES, ...TERMINAL_RUN_STATUSES],
    'leafItemDisposition.runStatus'
  );
  const decided = (itemStatus, decisionHash, reason) =>
    leafItemDisposition(item, bound.runId, itemStatus, decisionHash, reason);

  if (NONTERMINAL_RUN_STATUSES.includes(status)) {
    return decided(status, null, 'run_nonterminal');
  }

  // Declared-work agreement first. If the Run does not carry the item's exact
  // declared work, nothing it produced can be attributed to this item at all,
  // whatever its status or decision says.
  if (nullableHash(runDeclaredWorkHash, 'run.declaredWorkHash') !== bound.itemDeclaredWorkHash) {
    return decided('interrupted', null, 'declared_work_mismatch');
  }
  // A leaf Run always carries completion authority. One that reached a terminal
  // state without it cannot be evaluated, so it is unresolved rather than failed.
  if (nullableHash(runCompletionAuthorityHash, 'run.completionAuthorityHash') === null) {
    return decided('interrupted', null, 'run_terminal_without_authority');
  }
  if (!decision) {
    // A failed or interrupted Run is truthfully that even with no decision; only
    // `completed` is the claim that requires durable evidence to survive.
    return status === 'completed'
      ? decided('interrupted', null, 'completion_decision_missing')
      : decided(status === 'interrupted' ? 'interrupted' : 'failed', null,
        'completion_decision_missing');
  }
  if (decision.runId !== bound.runId || decision.ticketId !== bound.ticketId) {
    return decided('interrupted', null, 'completion_decision_stale');
  }
  if (decision.objectiveContractHash !== runCompletionAuthorityHash) {
    return decided('interrupted', null, 'completion_authority_mismatch');
  }
  const disposition = enumerated(
    decision.completionDisposition,
    COMPLETION_DISPOSITIONS,
    'completionDecision.completionDisposition'
  );
  const decisionHash = hash(decision.decisionHash, 'completionDecision.decisionHash');
  if (disposition === 'completed') {
    // A decision claiming completion for a Run that did not reach `completed`
    // contradicts the persisted lifecycle. Fail closed to unresolved.
    return status === 'completed'
      ? decided('completed', decisionHash, 'completion_verified')
      : decided('interrupted', null, 'completion_decision_conflicts_run');
  }
  if (disposition === 'blocked') {
    return decided('failed', decisionHash, 'completion_blocked');
  }
  return decided(
    status === 'interrupted' ? 'interrupted' : 'failed',
    decisionHash,
    'completion_unsuccessful'
  );
}

// ── Aggregate plan decision ─────────────────────────────────────────────────
//
// Deterministic, model-free, and fail-closed. The plan is complete only when
// every item has a valid completed decision. "All Runs terminal", "all agents
// said complete", "complete: true", and "the files exist" are explicitly not
// sufficient, and neither is "no running Runs remain".

function normalizeAggregateItem(value, index) {
  const label = `aggregatePlanDecision.items[${index}]`;
  exactFields(value, AGGREGATE_ITEM_FIELDS, label);
  if (!Array.isArray(value.runLineage)) fail(`${label}.runLineage must be an array`);
  const runId = value.runId === null ? null : positiveSafeInteger(value.runId, `${label}.runId`);
  const runLineage = value.runLineage
    .map((lineageRunId, position) =>
      positiveSafeInteger(lineageRunId, `${label}.runLineage[${position}]`))
    .sort((left, right) => left - right);
  if (new Set(runLineage).size !== runLineage.length) {
    fail(`${label}.runLineage must not repeat a run identity`);
  }
  if (runId !== null && !runLineage.includes(runId)) {
    fail(`${label}.runLineage must contain its bound run`);
  }
  const itemStatus = enumerated(value.itemStatus, LEAF_ITEM_STATUSES, `${label}.itemStatus`);
  const completionDecisionHash = nullableHash(
    value.completionDecisionHash,
    `${label}.completionDecisionHash`
  );
  if (itemStatus === 'completed' && completionDecisionHash === null) {
    // Not representable: a completed item without its supporting decision hash
    // is exactly the claim this contract exists to refuse. It is reported as
    // unresolved by the caller (deriveLeafItemDisposition never emits it).
    fail(`${label} claims completion without a supporting completion decision`,
      'COMPLETION_EVIDENCE_MISSING');
  }
  return {
    allocationItemId: positiveSafeInteger(value.allocationItemId, `${label}.allocationItemId`),
    assignedAgentId: positiveSafeInteger(value.assignedAgentId, `${label}.assignedAgentId`),
    runId,
    runLineage,
    itemStatus,
    completionDecisionHash,
    reason: enumerated(value.reason, LEAF_ITEM_DISPOSITION_REASONS, `${label}.reason`)
  };
}

function aggregateStatusFromItems(items) {
  // Order matters and is deliberate: an unresolved or interrupted item can
  // never be overridden by completed siblings, and a mix of completed and
  // failed is failure, never completion.
  if (items.some(item => item.itemStatus === 'failed')) return 'failed';
  if (items.some(item => item.itemStatus === 'interrupted')) return 'interrupted';
  if (items.some(item => NONTERMINAL_RUN_STATUSES.includes(item.itemStatus))) {
    return items.some(item => item.itemStatus === 'running') ? 'running' : 'pending';
  }
  if (items.length > 0 && items.every(item =>
    item.itemStatus === 'completed' && item.completionDecisionHash !== null)) {
    return 'completed';
  }
  // Unreachable through normalizeAggregateItem, which refuses a completed item
  // with no decision hash outright. Kept as the fail-closed floor: an
  // unclassifiable set is never reported as completion.
  return 'interrupted';
}

function buildAggregatePlanDecision({
  ticketId,
  allocationPlanId,
  planHash,
  planningAdmissionHash,
  items,
  decidedAt
}) {
  if (!Array.isArray(items) || items.length === 0) {
    fail('aggregatePlanDecision.items must be a non-empty array');
  }
  const normalizedItems = items
    .map(normalizeAggregateItem)
    .sort((left, right) => left.allocationItemId - right.allocationItemId);
  if (new Set(normalizedItems.map(item => item.allocationItemId)).size !== normalizedItems.length) {
    fail('aggregatePlanDecision.items must identify each allocation item exactly once');
  }
  const idsWith = predicate => normalizedItems
    .filter(predicate)
    .map(item => item.allocationItemId);
  const withoutHash = {
    version: AGGREGATE_PLAN_DECISION_VERSION,
    ticketId: positiveSafeInteger(ticketId, 'aggregatePlanDecision.ticketId'),
    allocationPlanId: positiveSafeInteger(allocationPlanId, 'aggregatePlanDecision.allocationPlanId'),
    planHash: hash(planHash, 'aggregatePlanDecision.planHash'),
    planningAdmissionHash: hash(
      planningAdmissionHash,
      'aggregatePlanDecision.planningAdmissionHash'
    ),
    items: normalizedItems,
    completedItemIds: idsWith(item => item.itemStatus === 'completed'),
    failedItemIds: idsWith(item => item.itemStatus === 'failed'),
    interruptedItemIds: idsWith(item => item.itemStatus === 'interrupted'),
    unresolvedItemIds: idsWith(item =>
      NONTERMINAL_RUN_STATUSES.includes(item.itemStatus) || item.itemStatus === 'interrupted'),
    aggregateStatus: aggregateStatusFromItems(normalizedItems),
    decidedAt: timestamp(decidedAt, 'aggregatePlanDecision.decidedAt')
  };
  return deepFreeze({ ...withoutHash, decisionHash: hashCanonical(withoutHash) });
}

function normalizeAggregatePlanDecision(value, {
  expectedPlanHash = null,
  expectedPlanId = null
} = {}) {
  exactFields(value, AGGREGATE_DECISION_FIELDS, 'aggregatePlanDecision');
  if (value.version !== AGGREGATE_PLAN_DECISION_VERSION) {
    fail(`aggregatePlanDecision.version must be ${AGGREGATE_PLAN_DECISION_VERSION}`);
  }
  const rebuilt = buildAggregatePlanDecision(value);
  // Derived fields are re-evaluated, never accepted. Without this the stored
  // aggregateStatus and item-set projections would be silently CORRECTED on
  // read: buildAggregatePlanDecision recomputes them, so a tampered stored
  // status would rebuild to the same decisionHash and verify. A durable
  // decision must fail to verify when its own bytes disagree with its items.
  for (const field of [
    'aggregateStatus',
    'completedItemIds',
    'failedItemIds',
    'interruptedItemIds',
    'unresolvedItemIds',
    'items'
  ]) {
    if (canonicalJson(value[field]) !== canonicalJson(rebuilt[field])) {
      fail(`aggregatePlanDecision.${field} does not match its evaluated items`);
    }
  }
  const decisionHash = hash(value.decisionHash, 'aggregatePlanDecision.decisionHash');
  if (decisionHash !== rebuilt.decisionHash) {
    fail('aggregatePlanDecision.decisionHash does not match its evaluated facts');
  }
  if (expectedPlanHash !== null &&
      rebuilt.planHash !== hash(expectedPlanHash, 'expected.planHash')) {
    fail('aggregatePlanDecision.planHash does not identify its allocation plan');
  }
  if (expectedPlanId !== null &&
      rebuilt.allocationPlanId !== positiveSafeInteger(expectedPlanId, 'expected.allocationPlanId')) {
    fail('aggregatePlanDecision.allocationPlanId does not identify its allocation plan');
  }
  return rebuilt;
}

// ── Projections ─────────────────────────────────────────────────────────────
//
// Read-only. Every value shown is a durable fact already validated above: the
// immutable binding, the admitted item authority, the derived item disposition
// and the aggregate decision. Nothing is recomputed from mutable configuration
// and nothing new is asserted about the parent Ticket, whose status stays the
// canonical transitionTicketAfterRun result and is reported verbatim.

// Four different questions, four fields. One boolean cannot answer them without
// lying about at least one:
//
//   plannerAdmittedPlan     does this ticket hold planner-admitted v2 authority
//   capabilityAvailable     does the PRODUCT support leaf-run admission at all
//   admissionState          none | not_admitted | admitted | settled
//   admissionBlockedReason  a closed refusal this ticket would hit right now
//   schedulerVisibleRunIds  which leaf Runs are actually claimable right now
//
// `admissionBlockedReason` reports only refusals derivable from durable
// authority. Agent existence, group authorization and worker-route readiness are
// live catalog facts proven inside the admission transaction, so a null here is
// "no KNOWN blocker", never a promise that admission would succeed — which is
// why there is deliberately no positive `ready: true`.
const LEAF_ADMISSION_STATES = Object.freeze([
  'none',
  'not_admitted',
  'admitted',
  'settled'
]);

function leafAdmissionBlockedReason(allocationPlan, ticketExecutionMode) {
  if (ticketExecutionMode === 'workflow') return 'leaf_execution_mode_unsupported';
  if (allocationPlan.items.some(item =>
    item.successCriteria.some(criterion => criterion.kind === 'typed-postcondition'))) {
    return 'leaf_item_typed_criteria_unsupported';
  }
  if (allocationPlan.status && allocationPlan.status !== 'pending') return 'plan_not_pending';
  return null;
}

function projectStructuredAllocationLeafExecution({
  allocationPlan = null,
  runs = [],
  ticketStatus = null,
  ticketExecutionMode = null
} = {}) {
  if (!allocationPlan || !Array.isArray(allocationPlan.items)) {
    return deepFreeze({
      plannerAdmittedPlan: false,
      capabilityAvailable: true,
      admissionState: 'none',
      admissionBlockedReason: null,
      schedulerVisibleRunIds: [],
      allocationPlanId: null,
      planHash: null,
      planStatus: null,
      items: [],
      completedItemIds: [],
      failedItemIds: [],
      unresolvedItemIds: [],
      aggregateDecision: null,
      parentTicketStatus: ticketStatus
    });
  }
  const bindingByItemId = new Map();
  const lineageByItemId = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const binding = run && run.leafRunBinding ? run.leafRunBinding : null;
    if (!binding || binding.allocationPlanId !== allocationPlan.id) continue;
    const verified = normalizeLeafRunBinding(binding, {
      expectedRunId: run.id,
      expectedPlanId: allocationPlan.id,
      expectedPlanHash: allocationPlan.planHash
    });
    const lineage = lineageByItemId.get(verified.allocationItemId) || [];
    lineage.push(run.id);
    lineageByItemId.set(verified.allocationItemId, lineage.sort((a, b) => a - b));
    const current = bindingByItemId.get(verified.allocationItemId);
    if (!current || verified.runId > current.runId) {
      bindingByItemId.set(verified.allocationItemId, verified);
    }
  }
  const decision = allocationPlan.aggregateDecision
    ? normalizeAggregatePlanDecision(allocationPlan.aggregateDecision, {
      expectedPlanHash: allocationPlan.planHash,
      expectedPlanId: allocationPlan.id
    })
    : null;
  const decidedByItemId = new Map(
    decision ? decision.items.map(item => [item.allocationItemId, item]) : []
  );
  const items = allocationPlan.items.map(item => {
    const binding = bindingByItemId.get(item.allocationItemId) || null;
    const decided = decidedByItemId.get(item.allocationItemId) || null;
    return {
      allocationItemId: item.allocationItemId,
      assignedAgentId: item.assignedAgentId,
      ownedOutputPaths: [...item.ownedOutputPaths],
      objective: item.objective.text,
      itemDeclaredWorkHash: binding ? binding.itemDeclaredWorkHash : null,
      parentDeclaredWorkHash: binding ? binding.parentDeclaredWorkHash : null,
      leafBindingHash: binding ? binding.bindingHash : null,
      runId: binding ? binding.runId : null,
      runLineage: lineageByItemId.get(item.allocationItemId) || [],
      itemStatus: decided ? decided.itemStatus : (item.status || null),
      dispositionReason: decided ? decided.reason : null,
      completionDecisionHash: decided ? decided.completionDecisionHash : null
    };
  });
  const boundItemCount = items.filter(item => item.runId !== null).length;
  const admissionState = boundItemCount === 0
    ? 'not_admitted'
    : ['completed', 'failed', 'interrupted'].includes(allocationPlan.status)
      ? 'settled'
      : 'admitted';
  return deepFreeze({
    plannerAdmittedPlan: true,
    capabilityAvailable: true,
    admissionState: enumerated(admissionState, LEAF_ADMISSION_STATES, 'admissionState'),
    admissionBlockedReason: admissionState === 'not_admitted'
      ? leafAdmissionBlockedReason(allocationPlan, ticketExecutionMode)
      : null,
    schedulerVisibleRunIds: (Array.isArray(runs) ? runs : [])
      .filter(run => run && run.leafRunBinding &&
        run.leafRunBinding.allocationPlanId === allocationPlan.id &&
        ['pending', 'running'].includes(run.status))
      .map(run => run.id)
      .sort((left, right) => left - right),
    allocationPlanId: allocationPlan.id,
    planHash: allocationPlan.planHash,
    planStatus: allocationPlan.status || null,
    items,
    completedItemIds: decision ? [...decision.completedItemIds] : [],
    failedItemIds: decision ? [...decision.failedItemIds] : [],
    unresolvedItemIds: decision
      ? [...decision.unresolvedItemIds]
      : items.filter(item => item.itemStatus !== 'completed')
        .map(item => item.allocationItemId),
    aggregateDecision: decision,
    parentTicketStatus: ticketStatus
  });
}

// A single leaf Run's binding, for Run Detail and CLI run inspection. Returns
// null for every historical and v1 Run, which is the honest answer: they hold
// no item-to-Run binding at all.
function projectLeafRunBindingForRun(run) {
  if (!run || !run.leafRunBinding) return null;
  return normalizeLeafRunBinding(run.leafRunBinding, { expectedRunId: run.id });
}

module.exports = {
  AGGREGATE_DECISION_FIELDS,
  LEAF_ADMISSION_STATES,
  AGGREGATE_ITEM_FIELDS,
  AGGREGATE_PLAN_DECISION_VERSION,
  LEAF_ADMISSION_MESSAGES,
  LEAF_ADMISSION_REFUSALS,
  LEAF_ITEM_DISPOSITION_REASONS,
  LEAF_ITEM_STATUSES,
  LEAF_RUN_BINDING_FIELDS,
  LEAF_RUN_BINDING_VERSION,
  StructuredAllocationLeafRunError,
  aggregateStatusFromItems,
  assertLeafBindingMatchesItem,
  assertLeafBindingSetComplete,
  assertLeafItemCompletionAuthoritySupported,
  buildAggregatePlanDecision,
  buildLeafDeclaredWorkSnapshot,
  buildLeafRunBinding,
  deriveLeafItemDisposition,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding,
  projectLeafRunBindingForRun,
  projectStructuredAllocationLeafExecution,
  refuseLeafAdmission: refuse
};

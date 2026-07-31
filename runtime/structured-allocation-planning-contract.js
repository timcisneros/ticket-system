'use strict';

// Tranche 2B — planner lowering and Allocation Plan v2 admission.
//
// This module owns everything between an admitted Tranche 2A authority and a
// deterministic Allocation Plan v2 draft. It performs no I/O: the server
// supplies live catalog facts, the provider response text, and the persistence
// layer; every decision here is a pure function of closed inputs.
//
// The division of authority is the point of the tranche. The model proposes
// decomposition CONTENT only — an objective, expected outputs, success criteria
// and shared constraints per candidate. Every identity, ownership grant,
// provenance label, criterion hash, evidence identity and authority hash is
// supplied by the runtime from the immutable Tranche 2A snapshot. A proposal
// that tries to state any of those is rejected rather than sanitized, because
// silently dropping a model-authored authority field would leave no evidence
// that the model attempted to widen its own grant.

const crypto = require('crypto');

const {
  assertDeclaredWorkEvidenceConsistency,
  canonicalJson,
  compareCanonicalText,
  deepFreeze,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('./declared-work-contract');
const {
  ALLOCATION_PLAN_VERSION,
  normalizeOwnedOutputPath
} = require('./allocation-plan-contract');

const PLANNER_REQUEST_CONTEXT_VERSION = 1;
const PLANNER_PROPOSAL_VERSION = 1;
const PLANNING_ATTEMPT_VERSION = 1;
const PLANNING_PROVENANCE_VERSION = 1;

// Provenance the runtime stamps on every model-proposed declaration. It is
// deliberately weaker than 'ticket-authored', so allocation-plan-contract's
// provenance-rank check can never see a model item claiming parent authority.
const PLANNER_PROPOSAL_PROVENANCE = 'validated-model-contract';

// The single evidence type the declared-work contract supports. Evidence is
// runtime-bound one-to-one from typed criteria, never proposed.
const RUNTIME_EVIDENCE_TYPE = 'deterministic-postcondition-result';

// Exactly one provider request per attempt, under these fixed bounds. There is
// no budget policy here — Tranche 4 owns economics. These are hard safety
// limits, not a spend decision.
//
// One number governs both acceptance and storage. An earlier split — accept up
// to 262,144 characters but store only 65,536 — produced a durable
// `response_received` state whose stored text was a truncated excerpt, and the
// proposal is persisted in a LATER transaction, so a crash in between left a
// record that could not be deterministically continued without re-asking the
// provider. A single byte limit enforced at transport receipt removes that
// window: whatever reaches `response_received` is the complete accepted
// response, hashed over exactly the bytes stored.
const MAX_PLANNER_RESPONSE_BYTES = 65_536;
const PLANNER_REQUEST_LIMITS = deepFreeze({
  maxRequests: 1,
  timeoutMs: 120_000,
  maxResponseBytes: MAX_PLANNER_RESPONSE_BYTES,
  maxStoredResponseBytes: MAX_PLANNER_RESPONSE_BYTES,
  maxStoredFailureDetail: 2_000,
  maxProposalItems: 64,
  maxSharedConstraints: 64,
  tools: false,
  workspaceOperations: false,
  browserOperations: false,
  processOperations: false,
  workflowCreation: false,
  handoff: false,
  recursion: false,
  providerFallback: false,
  modelFallback: false,
  repairRequest: false,
  automaticRetry: false
});

const PLANNING_ATTEMPT_STATES = Object.freeze([
  'created',
  'request_started',
  'response_received',
  'proposal_validated',
  'plan_admitted',
  'failed',
  'interrupted'
]);

// The stage that was being executed when an attempt stopped. A failed or
// interrupted attempt always names one of these; a successful attempt names none.
const PLANNING_ATTEMPT_STAGES = Object.freeze([
  'entry',
  'invocation_readiness',
  'request',
  'response',
  'parse',
  'proposal_validation',
  'lowering',
  'admission'
]);

const PLANNING_RESPONSE_STATUSES = Object.freeze([
  'received',
  'timeout',
  'aborted',
  'provider_error',
  'response_too_large',
  'outcome_unknown'
]);

// Closed refusal vocabulary. Every path that declines to plan, or declines to
// admit, names exactly one of these. Free-form provider text never becomes a
// reason code.
const PLANNING_ENTRY_REFUSALS = Object.freeze([
  'historical_authority_unavailable',
  'admission_ineligible',
  'assignment_changed_since_capture',
  'planning_attempt_already_active',
  'planning_attempt_already_failed',
  'allocation_plan_already_admitted',
  'structured_leaf_run_admission_not_available'
]);

const PLANNING_READINESS_REFUSALS = Object.freeze([
  'planner_agent_missing',
  'planner_not_group_planner',
  'planner_not_group_member',
  'planner_provider_drift',
  'planner_model_drift',
  'planner_credentials_unavailable',
  'candidate_agent_missing',
  'candidate_not_group_member',
  'assignment_changed_since_capture'
]);

const PLANNING_FAILURE_REASONS = Object.freeze([
  ...PLANNING_ENTRY_REFUSALS,
  ...PLANNING_READINESS_REFUSALS,
  'provider_request_failed',
  'provider_request_timed_out',
  'provider_response_too_large',
  'provider_response_empty',
  'provider_outcome_unknown',
  'proposal_not_exact_json',
  'proposal_contract_violation',
  'proposal_model_owned_authority',
  'proposal_candidate_mismatch',
  'proposal_legacy_placeholder',
  'proposal_lowering_rejected',
  'plan_validation_failed',
  'plan_admission_conflict'
]);

const PLANNING_REFUSAL_MESSAGES = deepFreeze({
  historical_authority_unavailable: 'Ticket has no admitted structured-allocation authority',
  admission_ineligible: 'Ticket was not eligible for structured allocation at admission',
  assignment_changed_since_capture: 'Current ticket assignment no longer matches captured planning authority',
  planning_attempt_already_active: 'A structured planning attempt is already in flight for this ticket',
  planning_attempt_already_failed: 'Structured planning already failed; no automatic retry is authorized',
  allocation_plan_already_admitted: 'An Allocation Plan v2 has already been admitted for this ticket',
  structured_leaf_run_admission_not_available: 'Structured leaf-run admission is not available until Tranche 3',
  planner_agent_missing: 'Snapshotted planner agent no longer exists',
  planner_not_group_planner: 'Snapshotted planner is no longer the group designated planner',
  planner_not_group_member: 'Snapshotted planner is no longer a member of the assignment group',
  planner_provider_drift: 'Current planner provider differs from the captured planning authority',
  planner_model_drift: 'Current planner model differs from the captured planning authority',
  planner_credentials_unavailable: 'Credentials for the snapshotted planner provider are unavailable',
  candidate_agent_missing: 'A snapshotted candidate agent no longer exists',
  candidate_not_group_member: 'A snapshotted candidate is no longer authorized through the assignment group',
  provider_request_failed: 'The bounded planner request failed before a durable response',
  provider_request_timed_out: 'The bounded planner request exceeded its fixed timeout',
  provider_response_too_large: 'The planner response exceeded the configured maximum response size',
  provider_response_empty: 'The planner returned no model output',
  provider_outcome_unknown: 'The planner request started and its outcome is not durably known',
  proposal_not_exact_json: 'The planner response was not exactly one JSON document',
  proposal_contract_violation: 'The planner proposal violated the closed proposal contract',
  proposal_model_owned_authority: 'The planner proposal claimed runtime-owned authority',
  proposal_candidate_mismatch: 'The planner proposal did not assign every captured candidate exactly once',
  proposal_legacy_placeholder: 'The planner proposal reproduced the legacy allocation placeholder',
  proposal_lowering_rejected: 'The planner proposal could not be lowered onto captured allocation authority',
  plan_validation_failed: 'The materialized Allocation Plan v2 failed deterministic validation',
  plan_admission_conflict: 'Ticket, route, or attempt state changed between response and admission'
});

const PROPOSAL_FIELDS = Object.freeze(['version', 'sharedConstraints', 'items']);
const PROPOSAL_ITEM_FIELDS = Object.freeze([
  'assignedAgentId',
  'objective',
  'expectedOutputs',
  'successCriteria',
  'evidenceRequirements'
]);
const PROPOSAL_CONSTRAINT_FIELDS = Object.freeze(['kind', 'declaration']);
const PROPOSAL_OUTPUT_FIELDS = Object.freeze(['kind', 'declaration']);
const PROPOSAL_TEXT_CRITERION_FIELDS = Object.freeze(['kind', 'declaration']);
const PROPOSAL_TYPED_CRITERION_FIELDS = Object.freeze([
  'kind',
  'criterionType',
  'declaration'
]);

// Fields the runtime owns absolutely. Their PRESENCE anywhere in the proposal
// document is itself the violation, reported distinctly from an ordinary
// contract error so operators can see that the model attempted to author
// authority rather than merely malforming its output.
const MODEL_FORBIDDEN_AUTHORITY_FIELDS = Object.freeze([
  'allocationItemId',
  'allocationPlanId',
  'admittedAt',
  'budget',
  'budgets',
  'capabilities',
  'capabilityGrants',
  'complete',
  'createdAt',
  'criterionHash',
  'executionPolicy',
  'groupId',
  'id',
  'itemStatuses',
  'mode',
  'model',
  'ownedOutputPaths',
  'parentDeclaredWorkSnapshot',
  'planHash',
  'planId',
  'planningProvenance',
  'provenance',
  'provider',
  'revision',
  'revisions',
  'status',
  'ticketId',
  'timestamps',
  'updatedAt'
]);

const PLANNING_ATTEMPT_FIELDS = Object.freeze([
  'version',
  'attemptId',
  'ticketId',
  'structuredAuthorityHash',
  'planningAuthoritySnapshotHash',
  'parentDeclaredWorkHash',
  'planner',
  'state',
  'requestHash',
  'requestMetadata',
  'requestStartedAt',
  'responseStatus',
  'responseText',
  'responseBytes',
  'responseTruncated',
  'responseHash',
  'parseStatus',
  'validationStatus',
  'proposalHash',
  'admittedPlanId',
  'admittedPlanHash',
  'failureStage',
  'failureReason',
  'failureDetail',
  'createdAt',
  'completedAt',
  'attemptStateHash'
]);

const PLANNING_ATTEMPT_PLANNER_FIELDS = Object.freeze([
  'agentId',
  'provider',
  'model'
]);

const PLANNING_ATTEMPT_REQUEST_METADATA_FIELDS = Object.freeze([
  'contextVersion',
  'contextHash',
  'messageCount',
  'requestBytes',
  'timeoutMs',
  'maxResponseBytes'
]);

const PLANNING_PROVENANCE_FIELDS = Object.freeze([
  'version',
  'attemptId',
  'plannerAgentId',
  'provider',
  'model',
  'planningAuthoritySnapshotHash',
  'parentDeclaredWorkHash',
  'requestHash',
  'responseHash',
  'proposalHash',
  'planHash',
  'admittedAt',
  'provenanceHash',
  'admissionHash'
]);

// Three independently validated values, not two.
//
//   planHash        immutable plan authority
//   provenanceHash  the planning facts that produced it
//   admissionHash   hash({planHash, provenanceHash}) — the PAIRING itself
//
// planHash already sits inside provenanceHash's preimage, so a transplant was
// already detectable; admissionHash makes the binding a first-class value that
// can be validated on its own, without recomputing the whole provenance record,
// and makes a half-written pair structurally impossible rather than merely
// improbable. It is stored beside the authority and is not part of planHash, so
// no historical plan changes meaning.
function computeAdmissionHash({ planHash, provenanceHash }) {
  return hashCanonical({ planHash, provenanceHash });
}

const PLANNER_REQUEST_CONTEXT_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'objective',
  'parentDeclaredWork',
  'allocationMode',
  'candidates',
  'sharedConstraints',
  'supportedFamilies',
  'prohibitions',
  'contextHash'
]);

// Terminal states cannot be left. `plan_admitted` in particular is idempotent:
// recovery observing it re-reports admission rather than re-admitting.
const PLANNING_ATTEMPT_TRANSITIONS = deepFreeze({
  created: ['request_started', 'failed'],
  request_started: ['response_received', 'failed', 'interrupted'],
  response_received: ['proposal_validated', 'failed'],
  proposal_validated: ['plan_admitted', 'failed'],
  plan_admitted: [],
  failed: [],
  interrupted: []
});

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The exact allocation subtask v1 writes for every item
// (server.js buildAllocatedOwnershipPlan). It describes no work: it names the
// ticket and tells the agent to stay inside a path it already owns. A planner
// that reproduces it has produced a decomposition with zero declared content,
// which is the precise failure Tranche 2B exists to prevent, so it is refused
// by identity rather than by a semantic judgement.
//
// The match is deliberately narrow: whitespace-collapsed, case-insensitive,
// with the ticket number as the only variable. It makes NO claim to recognize
// paraphrases, and must not be widened into one — a general "is this objective
// meaningful" test is not deterministic and is not authorized here.
const LEGACY_ALLOCATION_PLACEHOLDER_PATTERN =
  /^produce your allocated output for ticket \d+ inside your owned path only\.?$/;

class StructuredAllocationPlanningError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'StructuredAllocationPlanningError';
    this.code = code;
    this.stage = detail.stage || null;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'STRUCTURED_ALLOCATION_PLANNING_INVALID', detail = {}) {
  throw new StructuredAllocationPlanningError(code, message, detail);
}

function failProposal(message, reason = 'proposal_contract_violation') {
  fail(message, 'STRUCTURED_ALLOCATION_PROPOSAL_INVALID', {
    stage: 'proposal_validation',
    reason
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields, label, onFail = fail) {
  if (!isPlainObject(value)) onFail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const missing = fields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) {
    onFail(`${label} contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  if (missing.length > 0) onFail(`${label} is missing field(s): ${missing.join(', ')}`);
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
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

function nullableHash(value, label) {
  return value === null ? null : hash(value, label);
}

function timestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function nullableTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function enumerated(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is unsupported: ${String(value)}`);
  return value;
}

function nullableEnumerated(value, allowed, label) {
  return value === null ? null : enumerated(value, allowed, label);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function collapseWhitespace(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function isLegacyAllocationPlaceholder(value) {
  return LEGACY_ALLOCATION_PLACEHOLDER_PATTERN.test(collapseWhitespace(value).toLowerCase());
}

// ── Planner request context ─────────────────────────────────────────────────
//
// Only immutable admitted facts leave this process. Everything here comes from
// the Tranche 2A snapshot; nothing is read from live catalog state, the
// workspace, the filesystem, or the environment. There are no credentials,
// host paths, database rows, sibling runs, or process-launch material in this
// structure, and its closed field list is what keeps a later addition from
// quietly widening the disclosure.

function projectParentDeclaredWorkForPlanner(snapshot) {
  return {
    objective: snapshot.objective.text,
    expectedOutputs: snapshot.expectedOutputs.map(output => ({
      kind: output.kind,
      declaration: output.declaration
    })),
    successCriteria: snapshot.successCriteria.map(criterion => (
      criterion.kind === 'typed-postcondition'
        ? {
            kind: criterion.kind,
            criterionType: criterion.criterionType,
            declaration: criterion.declaration
          }
        : { kind: criterion.kind, declaration: criterion.declaration }
    )),
    evidenceRequirements: snapshot.evidenceRequirements.map(requirement => ({
      kind: requirement.kind,
      evidenceType: requirement.evidenceType
    }))
  };
}

function supportedFamiliesFromParent(snapshot) {
  const outputKinds = [...new Set(snapshot.expectedOutputs.map(output => output.kind))]
    .sort(compareCanonicalText);
  const criterionKinds = [...new Set(snapshot.successCriteria.map(criterion => (
    criterion.kind === 'typed-postcondition'
      ? `typed-postcondition:${criterion.criterionType}`
      : criterion.kind
  )))].sort(compareCanonicalText);
  const evidenceTypes = [...new Set(snapshot.evidenceRequirements.map(requirement =>
    `${requirement.kind}:${requirement.evidenceType}`))].sort(compareCanonicalText);
  return { outputKinds, criterionKinds, evidenceTypes };
}

function buildPlannerRequestContext(authority, { ticketId, sharedConstraints = [] } = {}) {
  const planning = authority.planningAuthoritySnapshot;
  if (!planning) fail('A planning-authority snapshot is required to build planner context');
  const parent = assertDeclaredWorkEvidenceConsistency(
    normalizeDeclaredWorkSnapshot(authority.parentDeclaredWorkSnapshot)
  );
  const withoutHash = {
    version: PLANNER_REQUEST_CONTEXT_VERSION,
    ticketId: positiveSafeInteger(ticketId, 'plannerRequestContext.ticketId'),
    objective: parent.objective.text,
    parentDeclaredWork: projectParentDeclaredWorkForPlanner(parent),
    allocationMode: planning.allocationMode,
    candidates: planning.candidates.map(candidate => ({
      agentId: candidate.agentId,
      name: candidate.name,
      ownedOutputPaths: [...candidate.ownedOutputPaths]
    })),
    sharedConstraints: (Array.isArray(sharedConstraints) ? sharedConstraints : [])
      .map(constraint => requiredString(constraint, 'plannerRequestContext.sharedConstraints[]')),
    supportedFamilies: supportedFamiliesFromParent(parent),
    prohibitions: [
      'Propose decomposition content only; the runtime supplies every identity, ' +
        'owned path, provenance, criterion hash, evidence identity and authority hash.',
      'Do not propose recursion, sub-delegation, child tickets, workflows, handoffs, ' +
        'tool calls, workspace operations, browser operations, or process launches.',
      'Do not claim completion, progress, budget, capability, provider, model, or routing authority.',
      'Do not widen the parent declaration: every output kind, criterion kind and ' +
        'evidence type you use must already appear in supportedFamilies.'
    ]
  };
  return deepFreeze({ ...withoutHash, contextHash: hashCanonical(withoutHash) });
}

function normalizePlannerRequestContext(value) {
  exactFields(value, PLANNER_REQUEST_CONTEXT_FIELDS, 'plannerRequestContext');
  if (value.version !== PLANNER_REQUEST_CONTEXT_VERSION) {
    fail(`plannerRequestContext.version must be ${PLANNER_REQUEST_CONTEXT_VERSION}`);
  }
  const withoutHash = Object.fromEntries(
    PLANNER_REQUEST_CONTEXT_FIELDS
      .filter(field => field !== 'contextHash')
      .map(field => [field, value[field]])
  );
  const contextHash = hash(value.contextHash, 'plannerRequestContext.contextHash');
  if (contextHash !== hashCanonical(withoutHash)) {
    fail('plannerRequestContext.contextHash does not match its sanitized context');
  }
  return deepFreeze({ ...withoutHash, contextHash });
}

// The instruction half of the request. It is derived deterministically from the
// hash-bound context, so the durable contextHash reconstructs exactly what was
// sent without storing a second copy of the prose.
function buildPlannerRequestMessages(context) {
  const normalized = normalizePlannerRequestContext(context);
  const system = [
    'You are an allocation planner. You decompose one already-admitted ticket into ' +
      'exactly one work item per listed candidate agent.',
    '',
    'Respond with exactly one JSON document and nothing else. No code fences, no ' +
      'commentary, no leading or trailing prose, no second JSON value.',
    '',
    'Response shape:',
    '{"version":1,"sharedConstraints":[{"kind":"text","declaration":"..."}],' +
      '"items":[{"assignedAgentId":0,"objective":"...","expectedOutputs":' +
      '[{"kind":"...","declaration":"..."}],"successCriteria":' +
      '[{"kind":"text","declaration":"..."}],"evidenceRequirements":[]}]}',
    '',
    'Rules:',
    '- Assign every candidate agentId in the context exactly once. Do not invent agents.',
    '- evidenceRequirements must be the empty array; the runtime binds evidence itself.',
    '- Every expectedOutputs.kind and successCriteria kind must appear in supportedFamilies.',
    '- A workflow-artifact output declaration must be a path inside that agent\'s ownedOutputPaths.',
    '- Do not emit ownedOutputPaths, provenance, ids, hashes, status, timestamps, ' +
      'provider, model, budgets, or any other field not shown above. Unknown fields are rejected.',
    '- Each objective must state the specific work for that agent. Restating the ticket ' +
      'number and the agent\'s own path is not a decomposition and will be rejected.'
  ].join('\n');
  const user = canonicalJson({
    ticketId: normalized.ticketId,
    objective: normalized.objective,
    parentDeclaredWork: normalized.parentDeclaredWork,
    allocationMode: normalized.allocationMode,
    candidates: normalized.candidates,
    sharedConstraints: normalized.sharedConstraints,
    supportedFamilies: normalized.supportedFamilies,
    prohibitions: normalized.prohibitions
  });
  return deepFreeze([
    { role: 'system', content: system },
    { role: 'user', content: user }
  ]);
}

function plannerRequestHash({ provider, model, messages }) {
  return hashCanonical({
    version: PLANNER_REQUEST_CONTEXT_VERSION,
    provider: requiredString(provider, 'plannerRequest.provider', 128),
    model: requiredString(model, 'plannerRequest.model', 512),
    messages: messages.map(message => ({
      role: message.role,
      content: message.content
    }))
  });
}

// ── Invocation readiness ────────────────────────────────────────────────────
//
// Evaluated immediately before the provider call, against live catalog facts,
// and again inside the admission transaction. It reads the captured authority
// and never writes it: live state can make a snapshot UNUSABLE, but it can
// never rewrite it, and no replacement planner, provider, model, candidate or
// owned path is ever selected.

function evaluatePlannerInvocationReadiness({ planningAuthoritySnapshot, current }) {
  const planning = planningAuthoritySnapshot;
  if (!planning) {
    return deepFreeze({ ready: false, refusalReasons: ['historical_authority_unavailable'] });
  }
  const facts = isPlainObject(current) ? current : {};
  const reasons = new Set();

  const plannerAgent = facts.plannerAgent || null;
  if (!plannerAgent || Number(plannerAgent.id) !== planning.planner.agentId) {
    reasons.add('planner_agent_missing');
  } else {
    if (Number(facts.groupPlannerAgentId) !== planning.planner.agentId) {
      reasons.add('planner_not_group_planner');
    }
    if (plannerAgent.provider !== planning.planner.provider) {
      reasons.add('planner_provider_drift');
    }
    // Compared against the agent's own recorded model, never against a resolved
    // provider config: getAgentOpenAIConfig/getAgentOllamaConfig fall back to
    // OPENAI_MODEL/OLLAMA_MODEL, and an environment fallback substituting a
    // different model is exactly the drift this check exists to catch.
    if (String(plannerAgent.model || '').trim() !== planning.planner.model) {
      reasons.add('planner_model_drift');
    }
    if (facts.plannerCredentialsAvailable !== true) {
      reasons.add('planner_credentials_unavailable');
    }
  }

  const memberIds = new Set(
    (Array.isArray(facts.groupMemberAgentIds) ? facts.groupMemberAgentIds : []).map(Number)
  );
  if (!memberIds.has(planning.planner.agentId)) reasons.add('planner_not_group_member');

  const currentAgentsById = new Map(
    (Array.isArray(facts.candidateAgents) ? facts.candidateAgents : [])
      .map(agent => [Number(agent.id), agent])
  );
  for (const candidate of planning.candidates) {
    if (!currentAgentsById.has(candidate.agentId)) {
      reasons.add('candidate_agent_missing');
      continue;
    }
    if (!memberIds.has(candidate.agentId)) reasons.add('candidate_not_group_member');
  }

  if (facts.assignmentMatchesCapturedAuthority !== true) {
    reasons.add('assignment_changed_since_capture');
  }

  const refusalReasons = PLANNING_READINESS_REFUSALS.filter(reason => reasons.has(reason));
  return deepFreeze({ ready: refusalReasons.length === 0, refusalReasons });
}

// ── Proposal parsing ────────────────────────────────────────────────────────
//
// Exactly one JSON document. `JSON.parse` alone is not sufficient: it accepts a
// bare string or number as a complete document, and it silently ignores nothing
// — so fences, prose and trailing values must be refused explicitly here, and
// no repair request is ever issued for a rejected response.

function parsePlannerProposalDocument(text) {
  if (typeof text !== 'string') {
    failProposal('Planner response must be text', 'proposal_not_exact_json');
  }
  const trimmed = text.trim();
  if (!trimmed) {
    failProposal('Planner response was empty', 'proposal_not_exact_json');
  }
  if (trimmed.includes('```')) {
    failProposal('Planner response contained a code fence', 'proposal_not_exact_json');
  }
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    failProposal(
      'Planner response must be exactly one JSON object with no surrounding prose',
      'proposal_not_exact_json'
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    failProposal(`Planner response was not valid JSON: ${error.message}`, 'proposal_not_exact_json');
  }
  if (!isPlainObject(parsed)) {
    failProposal('Planner response must be a JSON object', 'proposal_not_exact_json');
  }
  // JSON.parse stops at the first complete value, so "{} {}" parses as "{}".
  // Re-serializing and comparing token counts would be fragile; instead require
  // that the trimmed text is a single balanced document by re-parsing the
  // canonical form's own boundaries.
  const firstClose = findDocumentEnd(trimmed);
  if (firstClose !== trimmed.length) {
    failProposal(
      'Planner response contained more than one JSON value',
      'proposal_not_exact_json'
    );
  }
  return parsed;
}

// Index just past the first balanced top-level JSON object in `text`, honouring
// string literals and escapes so a brace inside a declaration is not counted.
function findDocumentEnd(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function assertNoModelOwnedAuthority(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoModelOwnedAuthority(item, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (MODEL_FORBIDDEN_AUTHORITY_FIELDS.includes(key)) {
      failProposal(
        `${label}.${key} is runtime-owned authority and must not be proposed`,
        'proposal_model_owned_authority'
      );
    }
    assertNoModelOwnedAuthority(value[key], `${label}.${key}`);
  }
}

function normalizeProposalConstraint(value, index) {
  const label = `plannerProposal.sharedConstraints[${index}]`;
  exactFields(value, PROPOSAL_CONSTRAINT_FIELDS, label, failProposal);
  if (value.kind !== 'text') failProposal(`${label}.kind must be text`);
  return {
    kind: 'text',
    declaration: requiredString(value.declaration, `${label}.declaration`)
  };
}

function normalizeProposalOutput(value, index, itemLabel) {
  const label = `${itemLabel}.expectedOutputs[${index}]`;
  exactFields(value, PROPOSAL_OUTPUT_FIELDS, label, failProposal);
  return {
    kind: requiredString(value.kind, `${label}.kind`, 128),
    declaration: requiredString(value.declaration, `${label}.declaration`)
  };
}

function normalizeProposalCriterion(value, index, itemLabel) {
  const label = `${itemLabel}.successCriteria[${index}]`;
  if (!isPlainObject(value)) failProposal(`${label} must be an object`);
  if (value.kind === 'text') {
    exactFields(value, PROPOSAL_TEXT_CRITERION_FIELDS, label, failProposal);
    return {
      kind: 'text',
      declaration: requiredString(value.declaration, `${label}.declaration`)
    };
  }
  exactFields(value, PROPOSAL_TYPED_CRITERION_FIELDS, label, failProposal);
  if (value.kind !== 'typed-postcondition') failProposal(`${label}.kind is unsupported`);
  return {
    kind: 'typed-postcondition',
    criterionType: requiredString(value.criterionType, `${label}.criterionType`, 128),
    declaration: requiredString(value.declaration, `${label}.declaration`)
  };
}

function normalizeProposalItem(value, index) {
  const label = `plannerProposal.items[${index}]`;
  exactFields(value, PROPOSAL_ITEM_FIELDS, label, failProposal);
  if (!Number.isSafeInteger(value.assignedAgentId) || value.assignedAgentId <= 0) {
    failProposal(`${label}.assignedAgentId must be a positive safe integer`);
  }
  const objective = requiredString(value.objective, `${label}.objective`);
  if (isLegacyAllocationPlaceholder(objective)) {
    failProposal(
      `${label}.objective reproduces the legacy allocation placeholder and declares no work`,
      'proposal_legacy_placeholder'
    );
  }
  if (!Array.isArray(value.expectedOutputs) || value.expectedOutputs.length === 0) {
    failProposal(`${label}.expectedOutputs must be a non-empty array`);
  }
  if (!Array.isArray(value.successCriteria) || value.successCriteria.length === 0) {
    failProposal(`${label}.successCriteria must be a non-empty array`);
  }
  if (!Array.isArray(value.evidenceRequirements) || value.evidenceRequirements.length !== 0) {
    failProposal(
      `${label}.evidenceRequirements must be the empty array; evidence identities are runtime-bound`,
      'proposal_model_owned_authority'
    );
  }
  return {
    assignedAgentId: value.assignedAgentId,
    objective,
    expectedOutputs: value.expectedOutputs.map((output, outputIndex) =>
      normalizeProposalOutput(output, outputIndex, label)),
    successCriteria: value.successCriteria.map((criterion, criterionIndex) =>
      normalizeProposalCriterion(criterion, criterionIndex, label)),
    evidenceRequirements: []
  };
}

function normalizePlannerProposal(value) {
  assertNoModelOwnedAuthority(value, 'plannerProposal');
  exactFields(value, PROPOSAL_FIELDS, 'plannerProposal', failProposal);
  if (value.version !== PLANNER_PROPOSAL_VERSION) {
    failProposal(`plannerProposal.version must be ${PLANNER_PROPOSAL_VERSION}`);
  }
  if (!Array.isArray(value.sharedConstraints)) {
    failProposal('plannerProposal.sharedConstraints must be an array');
  }
  if (value.sharedConstraints.length > PLANNER_REQUEST_LIMITS.maxSharedConstraints) {
    failProposal(
      `plannerProposal.sharedConstraints exceeds ${PLANNER_REQUEST_LIMITS.maxSharedConstraints} entries`
    );
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    failProposal('plannerProposal.items must be a non-empty array');
  }
  if (value.items.length > PLANNER_REQUEST_LIMITS.maxProposalItems) {
    failProposal(`plannerProposal.items exceeds ${PLANNER_REQUEST_LIMITS.maxProposalItems} entries`);
  }
  const items = value.items.map(normalizeProposalItem);
  const agentIds = items.map(item => item.assignedAgentId);
  if (new Set(agentIds).size !== agentIds.length) {
    failProposal(
      'plannerProposal.items must assign each agent at most once',
      'proposal_candidate_mismatch'
    );
  }
  const normalized = {
    version: PLANNER_PROPOSAL_VERSION,
    sharedConstraints: value.sharedConstraints.map(normalizeProposalConstraint),
    items: items.sort((left, right) => left.assignedAgentId - right.assignedAgentId)
  };
  return deepFreeze({ ...normalized, proposalHash: hashCanonical(normalized) });
}

// ── Runtime lowering ────────────────────────────────────────────────────────
//
// The proposal carries content; the captured authority carries everything else.
// This function is where they meet, and it is the only place that writes
// provenance, owned paths, criterion hashes or evidence identities onto model
// output. It emits an Allocation Plan v2 DRAFT — identities are reserved by the
// store inside the admission transaction, never here.

function loweredCriterion(criterion, label) {
  if (criterion.kind === 'text') {
    return {
      kind: 'text',
      declaration: criterion.declaration,
      provenance: PLANNER_PROPOSAL_PROVENANCE
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(criterion.declaration);
  } catch (_) {
    failProposal(`${label}.declaration must be canonical JSON for a typed criterion`);
  }
  // normalizePostcondition() in declared-work-contract returns canonicalValue()
  // of the same object, so canonicalising here yields the identical bytes the
  // downstream contract will hash — the runtime therefore owns the criterion
  // hash without duplicating the postcondition vocabulary.
  const declaration = canonicalJson(parsed);
  return {
    kind: 'typed-postcondition',
    criterionType: criterion.criterionType,
    declaration,
    criterionHash: sha256(declaration),
    provenance: PLANNER_PROPOSAL_PROVENANCE
  };
}

function lowerPlannerProposalToAllocationPlanDraft({ ticketId, authority, proposal }) {
  const planning = authority.planningAuthoritySnapshot;
  if (!planning) fail('A planning-authority snapshot is required to lower a proposal');
  const parent = assertDeclaredWorkEvidenceConsistency(
    normalizeDeclaredWorkSnapshot(authority.parentDeclaredWorkSnapshot)
  );
  const normalizedProposal = Object.prototype.hasOwnProperty.call(proposal, 'proposalHash')
    ? proposal
    : normalizePlannerProposal(proposal);

  const candidatesById = new Map(
    planning.candidates.map(candidate => [candidate.agentId, candidate])
  );
  const proposedIds = normalizedProposal.items.map(item => item.assignedAgentId);
  // Existing v1 production creates exactly one item per assigned group member,
  // so v2 preserves that cardinality: every captured candidate exactly once,
  // no unknown agent, no omission, no duplicate.
  for (const agentId of proposedIds) {
    if (!candidatesById.has(agentId)) {
      failProposal(
        `plannerProposal assigned agent ${agentId}, which is not a captured candidate`,
        'proposal_candidate_mismatch'
      );
    }
  }
  for (const candidate of planning.candidates) {
    if (!proposedIds.includes(candidate.agentId)) {
      failProposal(
        `plannerProposal omitted captured candidate ${candidate.agentId}`,
        'proposal_candidate_mismatch'
      );
    }
  }

  const items = normalizedProposal.items.map((item, index) => {
    const label = `plannerProposal.items[${index}]`;
    const candidate = candidatesById.get(item.assignedAgentId);
    const successCriteria = item.successCriteria.map((criterion, criterionIndex) =>
      loweredCriterion(criterion, `${label}.successCriteria[${criterionIndex}]`));
    // Evidence identity is derived, never proposed: the declared-work contract
    // requires exactly one postcondition-evidence requirement per typed
    // criterion, so the binding is total and deterministic.
    const evidenceRequirements = successCriteria
      .filter(criterion => criterion.kind === 'typed-postcondition')
      .map(criterion => ({
        kind: 'postcondition-evidence',
        criterionHash: criterion.criterionHash,
        evidenceType: RUNTIME_EVIDENCE_TYPE,
        provenance: PLANNER_PROPOSAL_PROVENANCE
      }));
    return {
      assignedAgentId: candidate.agentId,
      ownedOutputPaths: candidate.ownedOutputPaths.map(ownedPath =>
        normalizeOwnedOutputPath(ownedPath)),
      objective: {
        text: item.objective,
        provenance: PLANNER_PROPOSAL_PROVENANCE
      },
      expectedOutputs: item.expectedOutputs.map(output => ({
        kind: output.kind,
        declaration: output.declaration,
        provenance: PLANNER_PROPOSAL_PROVENANCE
      })),
      successCriteria,
      evidenceRequirements
    };
  });

  return deepFreeze({
    version: ALLOCATION_PLAN_VERSION,
    ticketId: positiveSafeInteger(ticketId, 'allocationPlan.ticketId'),
    mode: 'owned_paths',
    parentDeclaredWorkSnapshot: parent,
    sharedConstraints: normalizedProposal.sharedConstraints.map(constraint => ({
      kind: 'text',
      declaration: constraint.declaration,
      provenance: PLANNER_PROPOSAL_PROVENANCE
    })),
    items
  });
}

// ── Plan provenance ─────────────────────────────────────────────────────────
//
// Stored beside the v2 authority rather than inside planHash. AUTHORITY_FIELDS
// is a closed REQUIRED list, so adding provenance to it would make every
// Tranche 1 v2 plan fail exactFields on read and would change the meaning of
// every stored planHash — which the roadmap forbids. Instead provenance carries
// its own canonical hash AND embeds the planHash it describes, so it verifies
// independently and cannot be transplanted onto a different plan.

function buildPlanningProvenance({
  attemptId,
  plannerAgentId,
  provider,
  model,
  planningAuthoritySnapshotHash,
  parentDeclaredWorkHash,
  requestHash,
  responseHash,
  proposalHash,
  planHash,
  admittedAt
}) {
  const withoutHash = {
    version: PLANNING_PROVENANCE_VERSION,
    attemptId: attemptIdentity(attemptId, 'planningProvenance.attemptId'),
    plannerAgentId: positiveSafeInteger(plannerAgentId, 'planningProvenance.plannerAgentId'),
    provider: requiredString(provider, 'planningProvenance.provider', 128),
    model: requiredString(model, 'planningProvenance.model', 512),
    planningAuthoritySnapshotHash: hash(
      planningAuthoritySnapshotHash,
      'planningProvenance.planningAuthoritySnapshotHash'
    ),
    parentDeclaredWorkHash: hash(parentDeclaredWorkHash, 'planningProvenance.parentDeclaredWorkHash'),
    requestHash: hash(requestHash, 'planningProvenance.requestHash'),
    responseHash: hash(responseHash, 'planningProvenance.responseHash'),
    proposalHash: hash(proposalHash, 'planningProvenance.proposalHash'),
    planHash: hash(planHash, 'planningProvenance.planHash'),
    admittedAt: timestamp(admittedAt, 'planningProvenance.admittedAt')
  };
  const provenanceHash = hashCanonical(withoutHash);
  return deepFreeze({
    ...withoutHash,
    provenanceHash,
    admissionHash: computeAdmissionHash({
      planHash: withoutHash.planHash,
      provenanceHash
    })
  });
}

function normalizePlanningProvenance(value, {
  expectedPlanHash = null,
  expectedAttemptId = null
} = {}) {
  // exactFields requires BOTH hashes, so partial provenance or a partial
  // binding cannot be represented at all.
  exactFields(value, PLANNING_PROVENANCE_FIELDS, 'planningProvenance');
  if (value.version !== PLANNING_PROVENANCE_VERSION) {
    fail(`planningProvenance.version must be ${PLANNING_PROVENANCE_VERSION}`);
  }
  const rebuilt = buildPlanningProvenance(value);
  const provenanceHash = hash(value.provenanceHash, 'planningProvenance.provenanceHash');
  if (provenanceHash !== rebuilt.provenanceHash) {
    fail('planningProvenance.provenanceHash does not match its admitted facts');
  }
  const admissionHash = hash(value.admissionHash, 'planningProvenance.admissionHash');
  if (admissionHash !== rebuilt.admissionHash) {
    fail('planningProvenance.admissionHash does not bind its plan and provenance');
  }
  if (expectedPlanHash !== null && rebuilt.planHash !== expectedPlanHash) {
    fail('planningProvenance.planHash does not identify its allocation plan');
  }
  // One plan binds to one attempt, and one attempt to one plan.
  if (expectedAttemptId !== null && rebuilt.attemptId !== expectedAttemptId) {
    fail('planningProvenance.attemptId does not identify its planning attempt');
  }
  return rebuilt;
}

// Validate the pairing on its own, without rebuilding the provenance record.
function assertAdmissionBinding({ planHash, provenanceHash, admissionHash }) {
  const expected = computeAdmissionHash({
    planHash: hash(planHash, 'admissionBinding.planHash'),
    provenanceHash: hash(provenanceHash, 'admissionBinding.provenanceHash')
  });
  if (hash(admissionHash, 'admissionBinding.admissionHash') !== expected) {
    fail('admissionHash does not bind this plan hash to this provenance hash');
  }
  return true;
}

// ── Planning attempt ────────────────────────────────────────────────────────
//
// The smallest closed ticket-bound state that supports identity, idempotency,
// recovery, provider evidence, bounded response evidence, proposal evidence,
// admission outcome and projection. It is a field of the Ticket JSONB body and
// a stream of append-only Ticket events — not a new top-level product entity —
// because Ticket already provides transactional locking, revision-checked
// patching and event append in one statement.

function attemptIdentity(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(`${label} must be a lowercase UUID`);
  }
  return value;
}

function normalizeAttemptPlanner(value) {
  exactFields(value, PLANNING_ATTEMPT_PLANNER_FIELDS, 'planningAttempt.planner');
  return {
    agentId: positiveSafeInteger(value.agentId, 'planningAttempt.planner.agentId'),
    provider: requiredString(value.provider, 'planningAttempt.planner.provider', 128),
    model: requiredString(value.model, 'planningAttempt.planner.model', 512)
  };
}

function normalizeAttemptRequestMetadata(value) {
  if (value === null) return null;
  exactFields(value, PLANNING_ATTEMPT_REQUEST_METADATA_FIELDS, 'planningAttempt.requestMetadata');
  if (value.contextVersion !== PLANNER_REQUEST_CONTEXT_VERSION) {
    fail(`planningAttempt.requestMetadata.contextVersion must be ${PLANNER_REQUEST_CONTEXT_VERSION}`);
  }
  return {
    contextVersion: PLANNER_REQUEST_CONTEXT_VERSION,
    contextHash: hash(value.contextHash, 'planningAttempt.requestMetadata.contextHash'),
    messageCount: positiveSafeInteger(value.messageCount, 'planningAttempt.requestMetadata.messageCount'),
    requestBytes: positiveSafeInteger(value.requestBytes, 'planningAttempt.requestMetadata.requestBytes'),
    timeoutMs: positiveSafeInteger(value.timeoutMs, 'planningAttempt.requestMetadata.timeoutMs'),
    maxResponseBytes: positiveSafeInteger(
      value.maxResponseBytes,
      'planningAttempt.requestMetadata.maxResponseBytes'
    )
  };
}

function attemptWithoutHash(value) {
  return {
    version: PLANNING_ATTEMPT_VERSION,
    attemptId: attemptIdentity(value.attemptId, 'planningAttempt.attemptId'),
    ticketId: positiveSafeInteger(value.ticketId, 'planningAttempt.ticketId'),
    structuredAuthorityHash: hash(
      value.structuredAuthorityHash,
      'planningAttempt.structuredAuthorityHash'
    ),
    planningAuthoritySnapshotHash: hash(
      value.planningAuthoritySnapshotHash,
      'planningAttempt.planningAuthoritySnapshotHash'
    ),
    parentDeclaredWorkHash: hash(
      value.parentDeclaredWorkHash,
      'planningAttempt.parentDeclaredWorkHash'
    ),
    planner: normalizeAttemptPlanner(value.planner),
    state: enumerated(value.state, PLANNING_ATTEMPT_STATES, 'planningAttempt.state'),
    requestHash: nullableHash(value.requestHash, 'planningAttempt.requestHash'),
    requestMetadata: normalizeAttemptRequestMetadata(value.requestMetadata),
    requestStartedAt: nullableTimestamp(value.requestStartedAt, 'planningAttempt.requestStartedAt'),
    responseStatus: nullableEnumerated(
      value.responseStatus,
      PLANNING_RESPONSE_STATUSES,
      'planningAttempt.responseStatus'
    ),
    responseText: value.responseText === null
      ? null
      : boundedEvidenceText(value.responseText, 'planningAttempt.responseText'),
    responseBytes: value.responseBytes === null
      ? null
      : nonNegativeSafeInteger(value.responseBytes, 'planningAttempt.responseBytes'),
    responseTruncated: value.responseTruncated === null
      ? null
      : assertNotTruncated(value.responseTruncated, 'planningAttempt.responseTruncated'),
    responseHash: nullableHash(value.responseHash, 'planningAttempt.responseHash'),
    parseStatus: nullableEnumerated(
      value.parseStatus,
      ['ok', 'failed'],
      'planningAttempt.parseStatus'
    ),
    validationStatus: nullableEnumerated(
      value.validationStatus,
      ['ok', 'failed'],
      'planningAttempt.validationStatus'
    ),
    proposalHash: nullableHash(value.proposalHash, 'planningAttempt.proposalHash'),
    admittedPlanId: value.admittedPlanId === null
      ? null
      : positiveSafeInteger(value.admittedPlanId, 'planningAttempt.admittedPlanId'),
    admittedPlanHash: nullableHash(value.admittedPlanHash, 'planningAttempt.admittedPlanHash'),
    failureStage: nullableEnumerated(
      value.failureStage,
      PLANNING_ATTEMPT_STAGES,
      'planningAttempt.failureStage'
    ),
    failureReason: nullableEnumerated(
      value.failureReason,
      PLANNING_FAILURE_REASONS,
      'planningAttempt.failureReason'
    ),
    failureDetail: value.failureDetail === null
      ? null
      : requiredString(
        value.failureDetail,
        'planningAttempt.failureDetail',
        PLANNER_REQUEST_LIMITS.maxStoredFailureDetail
      ),
    createdAt: timestamp(value.createdAt, 'planningAttempt.createdAt'),
    completedAt: nullableTimestamp(value.completedAt, 'planningAttempt.completedAt')
  };
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be boolean`);
  return value;
}

// The field remains in the closed schema so the invariant is explicit in the
// record, but only `false` is representable: a truncated response is refused at
// transport receipt and never reaches a durable attempt. A stored `true` means
// the record predates this rule or was hand-edited, and it fails closed.
function assertNotTruncated(value, label) {
  assertBoolean(value, label);
  if (value === true) {
    fail(`${label} must be false; a truncated planner response is never durable`);
  }
  return false;
}

// Measured in BYTES, not UTF-16 code units: a multibyte response whose
// character count is under the limit can still exceed it on the wire, and the
// transport bound counts bytes.
function boundedEvidenceText(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_PLANNER_RESPONSE_BYTES) {
    fail(`${label} exceeds ${MAX_PLANNER_RESPONSE_BYTES} bytes`);
  }
  return value;
}

// State-shape invariants. These are what make a partially written attempt
// unreadable rather than quietly plausible.
function assertAttemptStateConsistency(attempt) {
  const terminalFailure = attempt.state === 'failed' || attempt.state === 'interrupted';
  if (terminalFailure) {
    if (attempt.failureStage === null || attempt.failureReason === null) {
      fail('A failed or interrupted planning attempt must name its stage and reason');
    }
    if (attempt.completedAt === null) {
      fail('A failed or interrupted planning attempt must record completedAt');
    }
  } else if (attempt.failureStage !== null || attempt.failureReason !== null) {
    fail('A non-terminal planning attempt must not record a failure stage or reason');
  }
  if (attempt.state === 'created') {
    if (attempt.requestHash !== null || attempt.requestStartedAt !== null) {
      fail('A created planning attempt has not issued its request');
    }
  }
  if (['request_started', 'response_received', 'proposal_validated', 'plan_admitted']
    .includes(attempt.state)) {
    if (attempt.requestHash === null || attempt.requestStartedAt === null ||
        attempt.requestMetadata === null) {
      fail(`planningAttempt state ${attempt.state} requires durable request evidence`);
    }
  }
  if (['response_received', 'proposal_validated', 'plan_admitted'].includes(attempt.state)) {
    if (attempt.responseHash === null || attempt.responseStatus !== 'received') {
      fail(`planningAttempt state ${attempt.state} requires a durable received response`);
    }
    // Recovery completeness: these states must carry enough hash-validated
    // durable material to deterministically continue with no second provider
    // request. That means the COMPLETE response text, whose byte count and hash
    // both agree with the stored bytes.
    if (typeof attempt.responseText !== 'string' || attempt.responseTruncated !== false) {
      fail(`planningAttempt state ${attempt.state} requires the complete durable response text`);
    }
    if (attempt.responseBytes !== Buffer.byteLength(attempt.responseText, 'utf8')) {
      fail('planningAttempt.responseBytes does not match its stored response text');
    }
    if (attempt.responseHash !== sha256(attempt.responseText)) {
      fail('planningAttempt.responseHash does not hash its stored response text');
    }
  }
  if (['proposal_validated', 'plan_admitted'].includes(attempt.state)) {
    if (attempt.parseStatus !== 'ok' || attempt.validationStatus !== 'ok' ||
        attempt.proposalHash === null) {
      fail(`planningAttempt state ${attempt.state} requires a validated proposal`);
    }
  }
  if (attempt.state === 'plan_admitted') {
    if (attempt.admittedPlanId === null || attempt.admittedPlanHash === null ||
        attempt.completedAt === null) {
      fail('An admitted planning attempt must record its plan identity, hash and completion');
    }
  } else if (attempt.admittedPlanId !== null || attempt.admittedPlanHash !== null) {
    fail('Only an admitted planning attempt may record an allocation plan');
  }
  return attempt;
}

function sealAttempt(withoutHash) {
  assertAttemptStateConsistency(withoutHash);
  return deepFreeze({ ...withoutHash, attemptStateHash: hashCanonical(withoutHash) });
}

function createPlanningAttempt({ attemptId, ticketId, authority, createdAt }) {
  const planning = authority.planningAuthoritySnapshot;
  if (!planning) fail('A planning-authority snapshot is required to create a planning attempt');
  return sealAttempt(attemptWithoutHash({
    version: PLANNING_ATTEMPT_VERSION,
    attemptId,
    ticketId,
    structuredAuthorityHash: authority.authorityHash,
    planningAuthoritySnapshotHash: planning.snapshotHash,
    parentDeclaredWorkHash: authority.parentDeclaredWorkSnapshot.contractHash,
    planner: {
      agentId: planning.planner.agentId,
      provider: planning.planner.provider,
      model: planning.planner.model
    },
    state: 'created',
    requestHash: null,
    requestMetadata: null,
    requestStartedAt: null,
    responseStatus: null,
    responseText: null,
    responseBytes: null,
    responseTruncated: null,
    responseHash: null,
    parseStatus: null,
    validationStatus: null,
    proposalHash: null,
    admittedPlanId: null,
    admittedPlanHash: null,
    failureStage: null,
    failureReason: null,
    failureDetail: null,
    createdAt,
    completedAt: null
  }));
}

function normalizePlanningAttempt(value, { expectedTicketId = null } = {}) {
  exactFields(value, PLANNING_ATTEMPT_FIELDS, 'planningAttempt');
  if (value.version !== PLANNING_ATTEMPT_VERSION) {
    fail(`planningAttempt.version must be ${PLANNING_ATTEMPT_VERSION}`);
  }
  const withoutHash = attemptWithoutHash(value);
  if (expectedTicketId !== null &&
      withoutHash.ticketId !== positiveSafeInteger(expectedTicketId, 'expectedTicketId')) {
    fail('planningAttempt.ticketId does not match its ticket');
  }
  assertAttemptStateConsistency(withoutHash);
  const attemptStateHash = hash(value.attemptStateHash, 'planningAttempt.attemptStateHash');
  if (attemptStateHash !== hashCanonical(withoutHash)) {
    fail('planningAttempt.attemptStateHash does not match its recorded state');
  }
  return deepFreeze({ ...withoutHash, attemptStateHash });
}

// The only writer of attempt state. Every transition is checked against the
// closed lifecycle, so a caller cannot skip a stage or revive a terminal
// attempt, and no path can mark an attempt admitted without having passed
// through a validated proposal.
function advancePlanningAttempt(attempt, patch) {
  const current = normalizePlanningAttempt(attempt);
  if (!isPlainObject(patch)) fail('planningAttempt patch must be an object');
  const unknown = Object.keys(patch).filter(field =>
    !PLANNING_ATTEMPT_FIELDS.includes(field) || field === 'attemptStateHash');
  if (unknown.length > 0) {
    fail(`planningAttempt patch contains unknown field(s): ${unknown.join(', ')}`);
  }
  const nextState = Object.prototype.hasOwnProperty.call(patch, 'state')
    ? enumerated(patch.state, PLANNING_ATTEMPT_STATES, 'planningAttempt.state')
    : current.state;
  if (nextState !== current.state &&
      !PLANNING_ATTEMPT_TRANSITIONS[current.state].includes(nextState)) {
    fail(
      `planningAttempt cannot transition from ${current.state} to ${nextState}`,
      'STRUCTURED_ALLOCATION_PLANNING_TRANSITION_INVALID'
    );
  }
  for (const immutable of [
    'version', 'attemptId', 'ticketId', 'structuredAuthorityHash',
    'planningAuthoritySnapshotHash', 'parentDeclaredWorkHash', 'planner', 'createdAt'
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, immutable)) {
      fail(`planningAttempt.${immutable} is immutable for the life of the attempt`);
    }
  }
  const merged = { ...current, ...patch, state: nextState };
  delete merged.attemptStateHash;
  return sealAttempt(attemptWithoutHash(merged));
}

// Recovery rule for a process that stopped after request initiation. The
// provider call is NEVER repeated automatically: an attempt whose outcome is
// not durably known becomes an explicit outcome-unknown terminal record.
function recoverInterruptedPlanningAttempt(attempt, { completedAt, detail = null }) {
  const current = normalizePlanningAttempt(attempt);
  if (current.state !== 'request_started') return current;
  return advancePlanningAttempt(current, {
    state: 'interrupted',
    responseStatus: 'outcome_unknown',
    failureStage: 'response',
    failureReason: 'provider_outcome_unknown',
    failureDetail: detail,
    completedAt
  });
}

// ── Projection ──────────────────────────────────────────────────────────────

function projectStructuredAllocationPlanningForTicket(ticket, { allocationPlan = null } = {}) {
  const attemptValue = ticket && ticket.structuredAllocationPlanningAttempt != null
    ? ticket.structuredAllocationPlanningAttempt
    : null;
  const attempt = attemptValue === null
    ? null
    : normalizePlanningAttempt(attemptValue, { expectedTicketId: ticket.id });
  const provenance = allocationPlan && allocationPlan.planningProvenance
    ? normalizePlanningProvenance(allocationPlan.planningProvenance, {
      expectedPlanHash: allocationPlan.planHash || null
    })
    : null;
  return deepFreeze({
    attempt,
    planningProvenance: provenance,
    // Tranche 3 owns leaf-run admission. Until it lands, an admitted plan is
    // authority only: nothing schedules it and nothing may claim it executed.
    leafExecutionAvailable: false,
    leafExecutionRefusalReason: 'structured_leaf_run_admission_not_available',
    leafExecutionRefusalMessage:
      PLANNING_REFUSAL_MESSAGES.structured_leaf_run_admission_not_available
  });
}

module.exports = {
  LEGACY_ALLOCATION_PLACEHOLDER_PATTERN,
  MODEL_FORBIDDEN_AUTHORITY_FIELDS,
  PLANNER_PROPOSAL_PROVENANCE,
  PLANNER_PROPOSAL_VERSION,
  PLANNER_REQUEST_CONTEXT_VERSION,
  PLANNER_REQUEST_LIMITS,
  PLANNING_ATTEMPT_STAGES,
  PLANNING_ATTEMPT_STATES,
  PLANNING_ATTEMPT_TRANSITIONS,
  PLANNING_ATTEMPT_VERSION,
  PLANNING_ENTRY_REFUSALS,
  PLANNING_FAILURE_REASONS,
  PLANNING_PROVENANCE_VERSION,
  PLANNING_READINESS_REFUSALS,
  PLANNING_REFUSAL_MESSAGES,
  PLANNING_RESPONSE_STATUSES,
  RUNTIME_EVIDENCE_TYPE,
  MAX_PLANNER_RESPONSE_BYTES,
  StructuredAllocationPlanningError,
  advancePlanningAttempt,
  assertAdmissionBinding,
  computeAdmissionHash,
  buildPlannerRequestContext,
  buildPlannerRequestMessages,
  buildPlanningProvenance,
  createPlanningAttempt,
  evaluatePlannerInvocationReadiness,
  isLegacyAllocationPlaceholder,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  normalizePlannerRequestContext,
  normalizePlanningAttempt,
  normalizePlanningProvenance,
  parsePlannerProposalDocument,
  plannerRequestHash,
  projectStructuredAllocationPlanningForTicket,
  recoverInterruptedPlanningAttempt
};

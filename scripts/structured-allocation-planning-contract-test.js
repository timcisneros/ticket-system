#!/usr/bin/env node
'use strict';

// Tranche 2B deterministic contract suite. Covers the planner request context,
// strict exact-JSON parsing, the closed proposal contract, runtime-owned
// lowering, invocation readiness, the attempt state machine, plan provenance,
// and the source boundary proving no Tranche 3 behavior is reachable.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  ALLOCATION_PLAN_VERSION,
  createAllocationPlanV2StorageBody,
  materializeAllocationPlanV2Draft,
  normalizeStoredAllocationPlanV2,
  serializeAllocationPlanV2StorageBody
} = require('../runtime/allocation-plan-contract');
const {
  buildStructuredAllocationAuthorityDraft,
  materializeStructuredAllocationAuthority
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  PLANNER_PROPOSAL_PROVENANCE,
  PLANNER_REQUEST_LIMITS,
  PLANNING_ATTEMPT_STATES,
  advancePlanningAttempt,
  buildPlannerRequestContext,
  buildPlannerRequestMessages,
  buildPlanningProvenance,
  createPlanningAttempt,
  evaluatePlannerInvocationReadiness,
  isLegacyAllocationPlaceholder,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  normalizePlanningAttempt,
  normalizePlanningProvenance,
  parsePlannerProposalDocument,
  plannerRequestHash,
  projectStructuredAllocationPlanningForTicket,
  recoverInterruptedPlanningAttempt
} = require('../runtime/structured-allocation-planning-contract');

const OBJECTIVE = 'Review each assigned folder and produce an independent report';
const CAPTURED_AT = '2026-07-31T00:00:00.000Z';

function admittedAuthority() {
  const draft = buildStructuredAllocationAuthorityDraft({
    declaredWork: {
      objective: OBJECTIVE,
      expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
      successCriteria: [{ kind: 'text', declaration: 'Every report contains findings' }],
      evidenceRequirements: []
    },
    ticketObjective: OBJECTIVE,
    assignmentTargetType: 'group',
    assignmentMode: 'allocated',
    assignmentGroup: { id: 7, name: 'Reviewers', revision: 2, plannerAgentId: 11 },
    plannerAgent: { id: 11, name: 'Planner', revision: 3, provider: 'openai', model: 'gpt-planner' },
    candidateAgents: [
      { id: 11, name: 'Planner', revision: 3 },
      { id: 12, name: 'Worker', revision: 1 }
    ],
    ownedOutputPaths: { 11: 'reports/alpha', 12: 'reports/beta' }
  });
  return materializeStructuredAllocationAuthority(draft, { ticketId: 42, capturedAt: CAPTURED_AT });
}

function validProposalDocument() {
  return {
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: [
      {
        assignedAgentId: 11,
        objective: 'Review reports/alpha and record concrete findings',
        expectedOutputs: [{ kind: 'text', declaration: 'Findings report for reports/alpha' }],
        successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
        evidenceRequirements: []
      },
      {
        assignedAgentId: 12,
        objective: 'Review reports/beta and record concrete findings',
        expectedOutputs: [{ kind: 'text', declaration: 'Findings report for reports/beta' }],
        successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
        evidenceRequirements: []
      }
    ]
  };
}

function reasonOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.reason || error.code || error.message;
  }
  return null;
}

function main() {
  const authority = admittedAuthority();
  assert.equal(authority.structuredAllocationEligibility.eligible, true);

  // ── Planner request context: only immutable admitted facts leave here ─────
  const context = buildPlannerRequestContext(authority, { ticketId: 42 });
  const serializedContext = JSON.stringify(context);
  for (const forbidden of ['apiKey', 'api_key', 'Bearer', 'baseUrl', 'revision', 'plannerAgentId']) {
    assert.equal(serializedContext.includes(forbidden), false,
      `planner context must not disclose ${forbidden}`);
  }
  assert.equal(serializedContext.includes('/home/'), false, 'planner context must not carry host paths');
  assert.deepEqual(context.candidates.map(candidate => candidate.agentId), [11, 12]);
  assert.deepEqual(context.candidates[0].ownedOutputPaths, ['reports/alpha/']);
  assert.equal(context.objective, OBJECTIVE);
  assert.equal(
    buildPlannerRequestContext(authority, { ticketId: 42 }).contextHash,
    context.contextHash,
    'planner context must be deterministically reconstructible'
  );

  const messages = buildPlannerRequestMessages(context);
  assert.equal(messages.length, 2);
  assert.equal(
    plannerRequestHash({ provider: 'openai', model: 'gpt-planner', messages }),
    plannerRequestHash({ provider: 'openai', model: 'gpt-planner', messages }),
    'request hash must be stable'
  );
  assert.notEqual(
    plannerRequestHash({ provider: 'openai', model: 'gpt-planner', messages }),
    plannerRequestHash({ provider: 'ollama', model: 'gpt-planner', messages }),
    'request hash must bind the route'
  );

  // ── Request bounds are fixed and forbid every escalation ─────────────────
  assert.equal(PLANNER_REQUEST_LIMITS.maxRequests, 1);
  assert.equal(PLANNER_REQUEST_LIMITS.timeoutMs, 120_000);
  assert.equal(PLANNER_REQUEST_LIMITS.maxResponseBytes, 262_144);
  for (const forbidden of [
    'tools', 'workspaceOperations', 'browserOperations', 'processOperations',
    'workflowCreation', 'handoff', 'recursion', 'providerFallback', 'modelFallback',
    'repairRequest', 'automaticRetry'
  ]) {
    assert.equal(PLANNER_REQUEST_LIMITS[forbidden], false, `${forbidden} must be refused`);
  }

  // ── Strict exact-JSON parsing ────────────────────────────────────────────
  const valid = JSON.stringify(validProposalDocument());
  assert.equal(parsePlannerProposalDocument(valid).version, 1);
  for (const [label, text] of [
    ['code fence', '```json\n' + valid + '\n```'],
    ['leading prose', 'Here is the plan: ' + valid],
    ['trailing prose', valid + '\nHope that helps.'],
    ['two documents', valid + ' ' + valid],
    ['malformed json', '{"version":1,'],
    ['empty', '   '],
    ['array document', '[]'],
    ['bare string', '"done"'],
    ['bare number', '7']
  ]) {
    assert.equal(reasonOf(() => parsePlannerProposalDocument(text)), 'proposal_not_exact_json',
      `${label} must be refused as not exactly one JSON document`);
  }

  // ── Closed proposal contract and forbidden model-owned authority ─────────
  const proposal = normalizePlannerProposal(validProposalDocument());
  assert.equal(proposal.proposalHash.length, 64);
  assert.deepEqual(proposal.items.map(item => item.assignedAgentId), [11, 12]);

  const withField = (mutate) => {
    const document = validProposalDocument();
    mutate(document);
    return document;
  };
  for (const [label, document] of [
    ['top-level planHash', withField(d => { d.planHash = 'x'; })],
    ['top-level ticketId', withField(d => { d.ticketId = 1; })],
    ['top-level mode', withField(d => { d.mode = 'owned_paths'; })],
    ['top-level status', withField(d => { d.status = 'pending'; })],
    ['item ownedOutputPaths', withField(d => { d.items[0].ownedOutputPaths = ['x']; })],
    ['item allocationItemId', withField(d => { d.items[0].allocationItemId = 1; })],
    ['output provenance', withField(d => { d.items[0].expectedOutputs[0].provenance = 'ticket-authored'; })],
    ['criterion hash', withField(d => { d.items[0].successCriteria[0].criterionHash = 'a'.repeat(64); })],
    ['constraint provenance', withField(d => { d.sharedConstraints[0].provenance = 'ticket-authored'; })],
    ['provider claim', withField(d => { d.provider = 'openai'; })],
    ['model claim', withField(d => { d.model = 'gpt-4'; })],
    ['budget claim', withField(d => { d.budget = 10; })],
    ['capability grant', withField(d => { d.items[0].capabilities = ['write']; })],
    ['completion claim', withField(d => { d.complete = true; })],
    ['timestamps', withField(d => { d.createdAt = CAPTURED_AT; })],
    ['revisions', withField(d => { d.revision = 2; })],
    ['non-empty evidence', withField(d => {
      d.items[0].evidenceRequirements = [{ kind: 'postcondition-evidence' }];
    })]
  ]) {
    assert.equal(reasonOf(() => normalizePlannerProposal(document)),
      'proposal_model_owned_authority',
      `${label} must be refused as runtime-owned authority`);
  }

  for (const [label, document] of [
    ['unknown item field', withField(d => { d.items[0].priority = 1; })],
    ['unknown top field', withField(d => { d.notes = 'hi'; })],
    ['wrong version', withField(d => { d.version = 2; })],
    ['empty items', withField(d => { d.items = []; })],
    ['missing outputs', withField(d => { d.items[0].expectedOutputs = []; })],
    ['missing criteria', withField(d => { d.items[0].successCriteria = []; })]
  ]) {
    assert.equal(reasonOf(() => normalizePlannerProposal(document)), 'proposal_contract_violation',
      `${label} must be refused by the closed contract`);
  }

  assert.equal(
    reasonOf(() => normalizePlannerProposal(withField(d => { d.items[1].assignedAgentId = 11; }))),
    'proposal_candidate_mismatch'
  );

  // ── Legacy placeholder rejection, deterministic and narrow ───────────────
  assert.equal(isLegacyAllocationPlaceholder(
    'Produce your allocated output for ticket 42 inside your owned path only.'), true);
  assert.equal(isLegacyAllocationPlaceholder(
    '  produce   your allocated OUTPUT for ticket 7 inside your owned path only  '), true);
  assert.equal(isLegacyAllocationPlaceholder(
    'Produce your allocated output for ticket 42 inside your owned path only'), true);
  assert.equal(isLegacyAllocationPlaceholder(
    'Review reports/alpha and record concrete findings'), false,
    'the placeholder check must not claim general semantic understanding');
  assert.equal(isLegacyAllocationPlaceholder(
    'Produce a security review for ticket 42 inside reports/alpha'), false);
  assert.equal(
    reasonOf(() => normalizePlannerProposal(withField(d => {
      d.items[0].objective = 'Produce your allocated output for ticket 42 inside your owned path only.';
    }))),
    'proposal_legacy_placeholder'
  );

  // ── Runtime-owned lowering ───────────────────────────────────────────────
  const draft = lowerPlannerProposalToAllocationPlanDraft({ ticketId: 42, authority, proposal });
  assert.equal(draft.version, ALLOCATION_PLAN_VERSION);
  assert.equal(draft.mode, 'owned_paths');
  assert.equal(draft.ticketId, 42);
  assert.equal(
    draft.parentDeclaredWorkSnapshot.contractHash,
    authority.parentDeclaredWorkSnapshot.contractHash,
    'lowering must inject the exact captured parent declared work'
  );
  assert.deepEqual(draft.items.map(item => item.ownedOutputPaths), [['reports/alpha/'], ['reports/beta/']],
    'lowering must inject captured owned paths, never proposed ones');
  for (const item of draft.items) {
    assert.equal(item.objective.provenance, PLANNER_PROPOSAL_PROVENANCE);
    for (const output of item.expectedOutputs) {
      assert.equal(output.provenance, PLANNER_PROPOSAL_PROVENANCE);
    }
  }
  assert.deepEqual(draft.sharedConstraints.map(c => c.provenance), [PLANNER_PROPOSAL_PROVENANCE]);

  // Cardinality: every captured candidate exactly once.
  assert.equal(
    reasonOf(() => lowerPlannerProposalToAllocationPlanDraft({
      ticketId: 42,
      authority,
      proposal: normalizePlannerProposal(withField(d => { d.items.pop(); }))
    })),
    'proposal_candidate_mismatch',
    'an omitted candidate must be refused'
  );
  assert.equal(
    reasonOf(() => lowerPlannerProposalToAllocationPlanDraft({
      ticketId: 42,
      authority,
      proposal: normalizePlannerProposal(withField(d => { d.items[1].assignedAgentId = 99; }))
    })),
    'proposal_candidate_mismatch',
    'an unknown candidate must be refused'
  );

  // Output outside ownership is refused by the v2 contract once lowered.
  assert.throws(
    () => materializeAllocationPlanV2Draft(
      lowerPlannerProposalToAllocationPlanDraft({
        ticketId: 42,
        authority,
        proposal: normalizePlannerProposal(withField(d => {
          d.items[0].expectedOutputs = [
            { kind: 'workflow-artifact', declaration: 'reports/beta/leak.md' }
          ];
        }))
      }),
      { id: 1, allocationItemIds: [1, 2] }
    ),
    error => ['ALLOCATION_PLAN_V2_OUTPUT_OUTSIDE_OWNERSHIP',
      'ALLOCATION_PLAN_V2_AUTHORITY_EXPANSION'].includes(error.code),
    'an output outside captured ownership must be refused'
  );

  const plan = materializeAllocationPlanV2Draft(draft, { id: 5, allocationItemIds: [100, 101] });
  assert.equal(plan.planHash.length, 64);
  assert.deepEqual(plan.items.map(item => item.allocationItemId), [100, 101]);

  // ── Invocation readiness ─────────────────────────────────────────────────
  const planning = authority.planningAuthoritySnapshot;
  const readyFacts = {
    plannerAgent: { id: 11, provider: 'openai', model: 'gpt-planner' },
    groupPlannerAgentId: 11,
    groupMemberAgentIds: [11, 12],
    candidateAgents: [{ id: 11 }, { id: 12 }],
    plannerCredentialsAvailable: true,
    assignmentMatchesCapturedAuthority: true
  };
  assert.deepEqual(
    evaluatePlannerInvocationReadiness({ planningAuthoritySnapshot: planning, current: readyFacts }),
    { ready: true, refusalReasons: [] }
  );
  const readinessCases = [
    ['planner_agent_missing', { plannerAgent: null }],
    ['planner_not_group_planner', { groupPlannerAgentId: 12 }],
    ['planner_not_group_member', { groupMemberAgentIds: [12] }],
    ['planner_provider_drift', { plannerAgent: { id: 11, provider: 'ollama', model: 'gpt-planner' } }],
    ['planner_model_drift', { plannerAgent: { id: 11, provider: 'openai', model: 'gpt-other' } }],
    ['planner_credentials_unavailable', { plannerCredentialsAvailable: false }],
    ['candidate_agent_missing', { candidateAgents: [{ id: 11 }] }],
    ['candidate_not_group_member', { groupMemberAgentIds: [11] }],
    ['assignment_changed_since_capture', { assignmentMatchesCapturedAuthority: false }]
  ];
  for (const [reason, override] of readinessCases) {
    const result = evaluatePlannerInvocationReadiness({
      planningAuthoritySnapshot: planning,
      current: { ...readyFacts, ...override }
    });
    assert.equal(result.ready, false, `${reason} must refuse`);
    assert.equal(result.refusalReasons.includes(reason), true,
      `${reason} must be reported; got ${result.refusalReasons.join(', ')}`);
  }
  // Readiness reads the snapshot; it never rewrites it.
  const beforeHash = planning.snapshotHash;
  evaluatePlannerInvocationReadiness({
    planningAuthoritySnapshot: planning,
    current: { ...readyFacts, plannerAgent: null }
  });
  assert.equal(planning.snapshotHash, beforeHash, 'readiness must not mutate captured authority');

  // ── Attempt lifecycle ────────────────────────────────────────────────────
  const attemptId = crypto.randomUUID();
  let attempt = createPlanningAttempt({
    attemptId,
    ticketId: 42,
    authority,
    createdAt: CAPTURED_AT
  });
  assert.equal(attempt.state, 'created');
  assert.equal(attempt.structuredAuthorityHash, authority.authorityHash);
  assert.equal(attempt.planningAuthoritySnapshotHash, planning.snapshotHash);
  assert.equal(attempt.parentDeclaredWorkHash, authority.parentDeclaredWorkSnapshot.contractHash);
  assert.equal(normalizePlanningAttempt(attempt).attemptStateHash, attempt.attemptStateHash);

  const requestMetadata = {
    contextVersion: context.version,
    contextHash: context.contextHash,
    messageCount: 2,
    requestBytes: 1024,
    timeoutMs: PLANNER_REQUEST_LIMITS.timeoutMs,
    maxResponseBytes: PLANNER_REQUEST_LIMITS.maxResponseBytes
  };
  const requestHash = plannerRequestHash({ provider: 'openai', model: 'gpt-planner', messages });
  const responseHash = crypto.createHash('sha256').update(valid).digest('hex');

  attempt = advancePlanningAttempt(attempt, {
    state: 'request_started',
    requestHash,
    requestMetadata,
    requestStartedAt: CAPTURED_AT
  });
  assert.equal(attempt.state, 'request_started');

  // Interrupted request: never repeated, always outcome-unknown.
  const interrupted = recoverInterruptedPlanningAttempt(attempt, {
    completedAt: '2026-07-31T00:05:00.000Z',
    detail: 'process restart'
  });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.responseStatus, 'outcome_unknown');
  assert.equal(interrupted.failureStage, 'response');
  assert.equal(interrupted.failureReason, 'provider_outcome_unknown');
  assert.equal(interrupted.admittedPlanId, null);
  assert.throws(() => advancePlanningAttempt(interrupted, { state: 'response_received' }),
    /cannot transition/, 'an interrupted attempt is terminal');
  assert.equal(
    recoverInterruptedPlanningAttempt(interrupted, { completedAt: CAPTURED_AT }).attemptStateHash,
    interrupted.attemptStateHash,
    'recovery of an already-recovered attempt is idempotent'
  );

  attempt = advancePlanningAttempt(attempt, {
    state: 'response_received',
    responseStatus: 'received',
    responseText: valid,
    responseBytes: valid.length,
    responseTruncated: false,
    responseHash
  });
  attempt = advancePlanningAttempt(attempt, {
    state: 'proposal_validated',
    parseStatus: 'ok',
    validationStatus: 'ok',
    proposalHash: proposal.proposalHash
  });
  const admitted = advancePlanningAttempt(attempt, {
    state: 'plan_admitted',
    admittedPlanId: 5,
    admittedPlanHash: plan.planHash,
    completedAt: '2026-07-31T00:10:00.000Z'
  });
  assert.equal(admitted.state, 'plan_admitted');
  assert.throws(() => advancePlanningAttempt(admitted, { state: 'failed' }),
    /cannot transition/, 'an admitted attempt is terminal and idempotent');

  // Stage skipping and authority rewriting are refused.
  const fresh = createPlanningAttempt({
    attemptId: crypto.randomUUID(), ticketId: 42, authority, createdAt: CAPTURED_AT
  });
  assert.throws(() => advancePlanningAttempt(fresh, { state: 'plan_admitted' }), /cannot transition/);
  assert.throws(() => advancePlanningAttempt(fresh, { state: 'response_received' }), /cannot transition/);
  assert.throws(() => advancePlanningAttempt(fresh, { ticketId: 43 }), /immutable/);
  assert.throws(() => advancePlanningAttempt(fresh, { planner: { agentId: 12, provider: 'openai', model: 'x' } }), /immutable/);
  assert.throws(() => advancePlanningAttempt(fresh, { unknownField: 1 }), /unknown field/);

  // Stage-accurate failure evidence: a parse failure and a validation failure
  // record different truths about the same stored response.
  let staged = advancePlanningAttempt(fresh, {
    state: 'request_started', requestHash, requestMetadata, requestStartedAt: CAPTURED_AT
  });
  staged = advancePlanningAttempt(staged, {
    state: 'response_received',
    responseStatus: 'received',
    responseText: valid,
    responseBytes: valid.length,
    responseTruncated: false,
    responseHash
  });
  const parseFailure = advancePlanningAttempt(staged, {
    parseStatus: 'failed',
    state: 'failed',
    failureStage: 'parse',
    failureReason: 'proposal_not_exact_json',
    failureDetail: 'response contained a code fence',
    completedAt: CAPTURED_AT
  });
  assert.equal(parseFailure.parseStatus, 'failed');
  assert.equal(parseFailure.validationStatus, null);
  assert.equal(parseFailure.responseHash, responseHash,
    'a rejected proposal keeps the evidence that justified the rejection');
  const loweringFailure = advancePlanningAttempt(staged, {
    parseStatus: 'ok',
    validationStatus: 'failed',
    state: 'failed',
    failureStage: 'lowering',
    failureReason: 'proposal_candidate_mismatch',
    failureDetail: 'omitted captured candidate 12',
    completedAt: CAPTURED_AT
  });
  assert.equal(loweringFailure.parseStatus, 'ok');
  assert.equal(loweringFailure.validationStatus, 'failed');
  for (const terminal of [parseFailure, loweringFailure]) {
    assert.equal(terminal.admittedPlanId, null);
    assert.equal(terminal.admittedPlanHash, null);
    assert.equal(normalizePlanningAttempt(terminal).attemptStateHash, terminal.attemptStateHash);
  }

  // Response evidence is bounded, and the hash always covers the whole response.
  const oversized = 'x'.repeat(PLANNER_REQUEST_LIMITS.maxStoredResponseBytes + 10);
  assert.throws(
    () => advancePlanningAttempt(staged, { responseText: oversized }),
    /exceeds/,
    'stored response evidence is bounded'
  );

  // Every terminal failure names its exact stage.
  const failed = advancePlanningAttempt(fresh, {
    state: 'failed',
    failureStage: 'invocation_readiness',
    failureReason: 'planner_model_drift',
    failureDetail: 'model changed',
    completedAt: CAPTURED_AT
  });
  assert.equal(failed.failureStage, 'invocation_readiness');
  assert.equal(failed.admittedPlanId, null, 'a failed attempt admits no plan');
  assert.throws(() => advancePlanningAttempt(fresh, { state: 'failed', completedAt: CAPTURED_AT }),
    /must name its stage and reason/);

  // Tampered stored state fails closed.
  // Consistency is checked before the state hash, so a tampered field is
  // refused by whichever invariant it breaks first — both are fail-closed.
  const failsClosed = error => error.name === 'StructuredAllocationPlanningError';
  assert.throws(() => normalizePlanningAttempt({ ...admitted, state: 'created' }), failsClosed);
  assert.throws(() => normalizePlanningAttempt({ ...admitted, admittedPlanId: 6 }), failsClosed);
  assert.throws(() => normalizePlanningAttempt({ ...admitted, proposalHash: 'c'.repeat(64) }), failsClosed);
  assert.throws(() => normalizePlanningAttempt({ ...admitted, extra: 1 }), /unknown field/);
  assert.throws(() => normalizePlanningAttempt(admitted, { expectedTicketId: 43 }), /does not match its ticket/);
  assert.equal(PLANNING_ATTEMPT_STATES.includes('plan_admitted'), true);

  // ── Plan provenance ──────────────────────────────────────────────────────
  const provenance = buildPlanningProvenance({
    attemptId,
    plannerAgentId: 11,
    provider: 'openai',
    model: 'gpt-planner',
    planningAuthoritySnapshotHash: planning.snapshotHash,
    parentDeclaredWorkHash: authority.parentDeclaredWorkSnapshot.contractHash,
    requestHash,
    responseHash,
    proposalHash: proposal.proposalHash,
    planHash: plan.planHash,
    admittedAt: '2026-07-31T00:10:00.000Z'
  });
  assert.equal(normalizePlanningProvenance(provenance, { expectedPlanHash: plan.planHash }).provenanceHash,
    provenance.provenanceHash);
  assert.throws(() => normalizePlanningProvenance({ ...provenance, model: 'gpt-other' }), /does not match/);
  assert.throws(
    () => normalizePlanningProvenance(provenance, { expectedPlanHash: 'b'.repeat(64) }),
    /does not identify its allocation plan/,
    'provenance cannot be transplanted onto another plan'
  );

  // ── Stored body carries provenance without changing planHash ─────────────
  const bodyWithout = createAllocationPlanV2StorageBody(plan, CAPTURED_AT);
  const bodyWith = createAllocationPlanV2StorageBody(plan, CAPTURED_AT, provenance);
  assert.equal(bodyWithout.planHash, bodyWith.planHash,
    'planning provenance must not change planHash');
  assert.equal(Object.prototype.hasOwnProperty.call(bodyWithout, 'planningProvenance'), false,
    'a plan without a planner omits the field entirely');

  const storedRow = {
    id: 5, ticketId: 42, status: 'pending', revision: 1,
    createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT
  };
  const legacy = normalizeStoredAllocationPlanV2({ ...storedRow, body: bodyWithout });
  assert.equal(legacy.planningProvenance, undefined,
    'existing Tranche 1 v2 plans remain readable and gain no synthesized provenance');
  const stored = normalizeStoredAllocationPlanV2({ ...storedRow, body: bodyWith });
  assert.equal(stored.planningProvenance.provenanceHash, provenance.provenanceHash);
  assert.equal(stored.status, 'pending');
  assert.equal(
    serializeAllocationPlanV2StorageBody(stored).planningProvenance.provenanceHash,
    provenance.provenanceHash,
    'an item-status write must not erase admission provenance'
  );
  assert.throws(
    () => normalizeStoredAllocationPlanV2({ ...storedRow, body: { ...bodyWith, unexpected: 1 } }),
    /unknown field/,
    'the stored v2 body stays closed'
  );

  // ── Projection ───────────────────────────────────────────────────────────
  const projection = projectStructuredAllocationPlanningForTicket(
    { id: 42, structuredAllocationPlanningAttempt: admitted },
    { allocationPlan: stored }
  );
  assert.equal(projection.attempt.state, 'plan_admitted');
  assert.equal(projection.planningProvenance.provenanceHash, provenance.provenanceHash);
  assert.equal(projection.leafExecutionAvailable, false);
  assert.equal(projection.leafExecutionRefusalReason, 'structured_leaf_run_admission_not_available');
  const emptyProjection = projectStructuredAllocationPlanningForTicket({ id: 42 });
  assert.equal(emptyProjection.attempt, null);
  assert.equal(emptyProjection.planningProvenance, null);
  assert.equal(emptyProjection.leafExecutionAvailable, false);

  // ── Source boundary: no Tranche 3 behavior is reachable from here ────────
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'runtime', 'structured-allocation-planning-contract.js'),
    'utf8'
  );
  for (const forbidden of [
    'prepareAgentRunDraft', 'persistPreparedAgentRuns', 'createRunsAndStartTicket',
    'createAgentRun', 'createRun(', 'createRetryRun', 'listPendingRuns', 'claimPendingRun',
    'scheduler', 'workspaceProvider', 'browserProvider', 'processProvider',
    'callModelProvider', 'fetch(', 'require(\'http', 'apiKey'
  ]) {
    assert.equal(source.includes(forbidden), false,
      `Tranche 2B contract must not reference ${forbidden}`);
  }

  console.log('structured allocation planning contract tests passed');
}

main();

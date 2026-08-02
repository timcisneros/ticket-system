'use strict';

// Shared test fixture for CURRENT valid governed structured state.
//
// After the Tranche 4 development cutover there is no ungoverned structured
// execution, so every suite that admits a structured leaf Run or advances a
// planning attempt past `created` needs real governed authority. This module
// builds it through the CANONICAL BUILDERS — no hand-written hashes, no
// "legacy structured" mode — so a fixture cannot drift away from what the
// runtime actually accepts.
//
// Suites whose subject is Tranche 3 leaf behaviour rather than economics use
// `zeroPricePolicySource()`, which is a fully valid governed authority whose
// catalog maximum is exactly zero. Every target, routing and authority check
// still applies; only the accounting arithmetic is trivial, which keeps those
// suites focused on their original subject.

const { readGovernedPolicySource } = require('../runtime/governed-policy-source');
const {
  buildProgressControlPolicy
} = require('../runtime/churn-decision-contract');

// Tranche 5 tolerance used by every governed fixture. Bounded, and generous
// enough that suites testing OTHER subjects are not incidentally blocked.
function progressControlPolicy(overrides = {}) {
  return buildProgressControlPolicy({
    maximumConsecutiveNoProgressWindows: 3,
    maximumRepeatedMutations: 3,
    maximumFailedOperationStreak: 4,
    maximumMutationReversals: 3,
    maximumInspectionOnlyStreak: 4,
    // Generous by design: suites testing OTHER subjects must not be
    // incidentally blocked on duration. Duration-specific suites override it.
    maximumCumulativeExecutionDurationMs: 3_600_000,
    resourceDimensions: ['provider_requests', 'settled_micro_usd'],
    ...overrides
  });
}

const PLANNER_ROLE = 'structured_planner';
const WORKER_ROLE = 'structured_leaf_executor';
const OPENAI_ADAPTER = 'openai.responses.v1';
// An exact dated snapshot. A mutable alias cannot be captured, by design.
const EXACT_SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const GOVERNED_ENDPOINT = 'https://api.openai.com/v1/responses';
const OUTPUT_CAP = 2_048;
const CAPTURED_AT = '2026-08-01T00:00:00.000Z';

// Illustrative fixture rates. NOT production authority.
function pricedCatalogValue(overrides = {}) {
  return {
    catalogId: 'fixture-catalog',
    entries: [{
      provider: 'openai',
      model: EXACT_SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  };
}

// Explicitly zero-priced: eligible because every applicable charge is exactly
// zero, never because a route is assumed free.
function zeroPriceCatalogValue() {
  return {
    catalogId: 'fixture-zero-catalog',
    entries: [{
      provider: 'openai',
      model: EXACT_SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 0,
      outputMicroUsdPerMillionTokens: 0,
      requestMicroUsd: 0,
      boundMethod: 'catalog_maximum_exactly_zero'
    }]
  };
}

function policySource({
  role,
  catalog,
  model = EXACT_SNAPSHOT,
  authorizedMicroUsd = 500_000,
  maximumProviderRequests = 3
}) {
  const built = require('../runtime/model-pricing-catalog').buildPricingCatalog(catalog);
  const container = {
    body: {
      // Legacy container siblings, present so fixtures prove they are ignored.
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-ignored',
      governedExecution: {
        roleRoutingPolicy: {
          policyId: `${role}-routing-1`,
          rolePolicies: [{
            role,
            primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model },
            fallbackRoute: null,
            authorizedFallbackReasons: []
          }]
        },
        economicPolicy: {
          policyId: `${role}-economics-1`,
          role,
          authorizedMicroUsd,
          maximumProviderRequests,
          maximumOutputTokensPerRequest: OUTPUT_CAP,
          pricingCatalogId: built.catalogId,
          pricingCatalogHash: built.catalogHash,
          fallbackLiabilityAuthorized: false,
          fallbackProviderRequests: 0,
          capturedAt: CAPTURED_AT
        },
        pricingCatalog: catalog
      }
    }
  };
  // Both forms: the normalized source production consumes, and the raw
  // container capture reads. A fixture must never feed normalized documents
  // back into a container — the closed key sets would reject them, and rightly.
  const source = readGovernedPolicySource(container, { role });
  return { source, container, role };
}

function workerPolicySource(options = {}) {
  return policySource({
    role: WORKER_ROLE, catalog: pricedCatalogValue(), ...options
  });
}

function plannerPolicySource(options = {}) {
  return policySource({
    role: PLANNER_ROLE, catalog: pricedCatalogValue(), maximumProviderRequests: 1, ...options
  });
}

// For Tranche 3 suites: complete, valid governed authority whose accounting is
// trivially zero so it cannot distract from the subject under test.
function zeroPriceWorkerPolicySource(options = {}) {
  return policySource({
    role: WORKER_ROLE, catalog: zeroPriceCatalogValue(), ...options
  });
}

function zeroPricePlannerPolicySource(options = {}) {
  return policySource({
    role: PLANNER_ROLE, catalog: zeroPriceCatalogValue(), maximumProviderRequests: 1, ...options
  });
}

// The capture a planning attempt needs to become request-capable, and the
// governed block that is attached to it from `request_started` onward.
function capturePlannerFor({ ticketId, planningAttemptId, plannerAgentId, policy }) {
  const {
    capturePlannerGovernance
  } = require('../runtime/structured-planner-governance');
  return capturePlannerGovernance({
    ticketId,
    planningAttemptId,
    plannerAgentId,
    policyContainer: policy.container,
    plannerInput: [{ role: 'user', content: 'Allocate the declared work.' }],
    endpointIdentity: GOVERNED_ENDPOINT,
    capturedAt: new Date().toISOString()
  });
}

// A COMPLETE governed attempt block for PURE CONTRACT suites that have no
// store. Every hash comes from a real capture through the canonical builders;
// only the account and reservation identities are fixture integers, because
// those are database identities a contract test legitimately has none of.
function governedAttemptStateWithoutStore({
  ticketId = 7,
  attemptId = '3f1d6c58-4a2b-4a1e-9f7c-5b8e2d0a6c41',
  plannerAgentId = 1,
  policy = null,
  economicAccountId = 1,
  reservationId = 1,
  economicState = 'request_started',
  settlementReceiptHash = null
} = {}) {
  const {
    buildGovernedExecutionState
  } = require('../runtime/structured-planner-governance');
  const resolved = policy || plannerPolicySource();
  const capture = capturePlannerFor({
    ticketId, planningAttemptId: attemptId, plannerAgentId, policy: resolved
  });
  return buildGovernedExecutionState({
    capture, economicAccountId, reservationId, economicState, settlementReceiptHash
  });
}

// A COMPLETE governed attempt block, produced the way production produces one:
// capture, admit the planner account, reserve the exact request, then build the
// block that binds them. Nothing is hand-written, so a fixture cannot assert a
// shape the runtime would reject.
async function governedAttemptState(store, {
  ticketId, attemptId, plannerAgentId, policy, economicState = 'request_started'
}) {
  const {
    buildGovernedExecutionState
  } = require('../runtime/structured-planner-governance');
  const capture = capturePlannerFor({
    ticketId, planningAttemptId: attemptId, plannerAgentId, policy
  });
  const account = await store.admitTicketEconomicAccount({
    ticketId, role: PLANNER_ROLE, economicPolicy: capture.source.economicPolicy
  });
  const reservation = await store.reserveEconomicRequest({
    preparedRequest: capture.preparedRequest,
    economicAuthority: capture.economicAuthority,
    pricingEntry: capture.pricingEntry
  });
  return {
    capture,
    reservation,
    governedExecution: buildGovernedExecutionState({
      capture,
      economicAccountId: Number(account.account.id),
      reservationId: reservation.id,
      economicState
    })
  };
}


// ── A complete governed structured leaf Ticket, seeded canonically ──────────
//
// Drives the SAME path production does: authority draft, real planning attempt
// advanced to `proposal_validated`, v2 plan admission, then leaf-run admission
// with governed capture. Nothing is inserted directly and no hash is written by
// hand, so a suite built on this cannot pass against a fixture the runtime
// would reject.
async function seedGovernedStructuredTicket(store, {
  stamp = `seed-${Date.now()}`,
  actor = 'governed-structured-fixture',
  progressPolicy = progressControlPolicy(),
  policySource = null
} = {}) {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const {
    buildStructuredAllocationAuthorityDraft
  } = require('../runtime/structured-allocation-prerequisites-contract');
  const {
    advancePlanningAttempt,
    buildPlannerRequestContext,
    buildPlannerRequestMessages,
    createPlanningAttempt,
    lowerPlannerProposalToAllocationPlanDraft,
    normalizePlannerProposal,
    plannerRequestHash
  } = require('../runtime/structured-allocation-planning-contract');
  const {
    buildLeafDeclaredWorkSnapshot
  } = require('../runtime/structured-allocation-leaf-run-contract');
  const {
    buildCompletionAuthoritySnapshot
  } = require('../runtime/completion-decision-contract');

  const group = (await store.createGroup({
    value: { name: `Seed ${stamp}`, permissions: [], canReceiveTickets: true },
    changedBy: actor
  })).group;
  const mkAgent = async name => (await store.createConfiguredAgent({
    value: { name: `${name} ${stamp}`, provider: 'openai',
      model: 'gpt-agent-row-model', apiKey: '' },
    groupIds: [group.id], changedBy: actor
  })).agent;
  const planner = await mkAgent('Planner');
  const workerA = await mkAgent('WorkerA');
  const workerB = await mkAgent('WorkerB');
  const designated = (await store.updateGroup({
    groupId: group.id, expectedRevision: group.revision,
    value: { ...group, plannerAgentId: planner.id }, changedBy: actor
  })).group;
  const ownedOutputPaths = {
    [planner.id]: 'reports/planner/',
    [workerA.id]: 'reports/a/',
    [workerB.id]: 'reports/b/'
  };

  const objectiveText = `Seeded governed structured work ${stamp}`;
  const catalog = await store.getConfiguredAgentsByIds({
    agentIds: [planner.id, workerA.id, workerB.id] });
  const authorityDraft = buildStructuredAllocationAuthorityDraft({
    declaredWork: {
      objective: objectiveText,
      expectedOutputs: [{ kind: 'text', declaration: 'One report per folder' }],
      successCriteria: [{ kind: 'text', declaration: 'Findings are concrete' }],
      evidenceRequirements: []
    },
    ticketObjective: objectiveText,
    assignmentTargetType: 'group',
    assignmentMode: 'allocated',
    assignmentGroup: designated,
    plannerAgent: catalog.find(agent => agent.id === planner.id),
    candidateAgents: catalog,
    ownedOutputPaths
  });

  const now = new Date().toISOString();
  const ticket = (await store.createTicketWithEvent({
    ticket: {
      objective: objectiveText, acceptanceCriteria: 'Review the reports.',
      assignmentTargetType: 'group', assignmentTargetId: group.id,
      assignmentMode: 'allocated', ownedOutputPaths,
      targetRef: null, executionMode: 'agent', workflowId: null, workflowInput: null,
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
      capabilityInput: null,
      executionPolicy: {
        mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
        maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
        maxWorkspaceOperations: null, allowWorkspaceWrites: true,
        allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
      },
      status: 'open', blockedReason: null, createdBy: actor, changedBy: actor,
      changedAt: now, createdAt: now, updatedAt: now
    },
    structuredAllocationAuthorityDraft: authorityDraft,
    eventPayload: { source: actor }
  })).ticket;

  const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
  const responseText = JSON.stringify({
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: planning.candidates.map(candidate => ({
      assignedAgentId: candidate.agentId,
      objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
      expectedOutputs: [{ kind: 'text',
        declaration: `Findings report for ${candidate.ownedOutputPaths[0]}` }],
      successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
      evidenceRequirements: []
    }))
  });
  const proposal = normalizePlannerProposal(JSON.parse(responseText));
  const planDraft = lowerPlannerProposalToAllocationPlanDraft({
    ticketId: ticket.id, authority: ticket.structuredAllocationAuthority, proposal
  });

  const context = buildPlannerRequestContext(
    ticket.structuredAllocationAuthority, { ticketId: ticket.id });
  const messages = buildPlannerRequestMessages(context);
  let attempt = createPlanningAttempt({
    attemptId: crypto.randomUUID(), ticketId: ticket.id,
    authority: ticket.structuredAllocationAuthority,
    createdAt: new Date().toISOString()
  });
  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id, attempt, expectedAttemptStateHash: null,
    eventType: 'ticket.structured_planning_started'
  })).attempt;
  const { governedExecution: plannerGoverned } = await governedAttemptState(store, {
    ticketId: ticket.id, attemptId: attempt.attemptId,
    plannerAgentId: planning.planner.agentId, policy: plannerPolicySource()
  });
  const advance = async patch => {
    attempt = (await store.writeStructuredAllocationPlanningAttempt({
      ticketId: ticket.id,
      attempt: advancePlanningAttempt(attempt, patch),
      expectedAttemptStateHash: attempt.attemptStateHash,
      eventType: 'ticket.structured_planning_step'
    })).attempt;
  };
  await advance({
    state: 'request_started',
    governedExecution: plannerGoverned,
    requestHash: plannerRequestHash({
      provider: planning.planner.provider, model: planning.planner.model, messages }),
    requestMetadata: {
      contextVersion: context.version, contextHash: context.contextHash,
      messageCount: messages.length,
      requestBytes: messages.reduce((total, message) => total + message.content.length, 0),
      timeoutMs: 120_000, maxResponseBytes: 262_144
    },
    requestStartedAt: new Date().toISOString()
  });
  await advance({
    state: 'response_received', responseStatus: 'received', responseText,
    responseBytes: Buffer.byteLength(responseText, 'utf8'), responseTruncated: false,
    responseHash: crypto.createHash('sha256').update(responseText).digest('hex')
  });
  await advance({
    state: 'proposal_validated', parseStatus: 'ok', validationStatus: 'ok',
    proposalHash: proposal.proposalHash
  });

  const admission = await store.admitStructuredAllocationPlan({
    ticketId: ticket.id, attempt, allocationPlanDraft: planDraft,
    plannerCredentialsAvailable: true, eventPayload: { source: actor }
  });
  assert.equal(admission.admitted, true, 'the seeded v2 plan is admitted');
  const plan = admission.plan;
  const refreshed = await store.getTicket(ticket.id);

  const agentById = new Map([[planner.id, planner], [workerA.id, workerA],
    [workerB.id, workerB]]);
  const leafDrafts = plan.items.map(item => {
    const agent = agentById.get(item.assignedAgentId);
    // Deterministic completion authority, matching what production's
    // `buildRunCompletionAuthoritySnapshot` derives for a recognized objective.
    // Governed leaf admission now refuses a Run with no execution-evaluable
    // fact, because such a Run could never be credited with verified progress
    // and would eventually stop with a reason that was false about its work.
    const completionAuthoritySnapshot = buildCompletionAuthoritySnapshot({
      objective: `Create folder ${item.ownedOutputPaths[0].replace(/\/$/, '')}`,
      kind: 'deterministic', recognized: true,
      intent: 'create_folder', completionPolicy: 'declared_postconditions',
      directPostconditions: [{
        type: 'folder_exists',
        path: item.ownedOutputPaths[0].replace(/\/$/, '')
      }],
      verificationPolicy: 'when_declared',
      capturedAt: new Date().toISOString()
    });
    return {
      allocationItemId: item.allocationItemId,
      run: {
        ticketId: refreshed.id, agentId: agent.id, agentName: agent.name,
        targetRef: null, workspaceRoot: '/tmp', mainWorkspaceRoot: '/tmp',
        executionWorkspaceType: 'main_owned_paths',
        executionPolicySnapshot: refreshed.executionPolicy,
        completionAuthoritySnapshot,
        declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
          sharedConstraints: plan.sharedConstraints, completionAuthoritySnapshot
        }),
        acceptanceCriteriaSnapshot: null,
        allocationPlanId: plan.id, allocationItemId: item.allocationItemId,
        allocationSubtask: null, ownedOutputPaths: [...item.ownedOutputPaths],
        executionMode: 'agent', capabilityType: 'directAction',
        capabilityId: 'agent-selected-actions', currentPhase: 'planning',
        status: 'pending'
      }
    };
  });

  const admitted = await store.admitStructuredAllocationLeafRuns({
    ticketId: refreshed.id,
    allocationPlanId: plan.id,
    leafDrafts,
    governedLeafCapture: {
      // The store expects the INNER closed policy document, not the reader's
      // wrapper. `workerPolicySource()` returns { source, container, role }.
      policySource: policySource || workerPolicySource().source,
      progressControlPolicy: progressPolicy
    },
    eventPayload: { source: actor }
  });

  return {
    ticket: refreshed,
    ticketId: refreshed.id,
    plan,
    admission: admitted,
    runIds: admitted.runs.map(run => run.id),
    agents: { planner, workerA, workerB },
    group: designated
  };
}

module.exports = {
  progressControlPolicy,
  seedGovernedStructuredTicket,
  governedAttemptState,
  governedAttemptStateWithoutStore,
  CAPTURED_AT,
  EXACT_SNAPSHOT,
  GOVERNED_ENDPOINT,
  OPENAI_ADAPTER,
  OUTPUT_CAP,
  PLANNER_ROLE,
  WORKER_ROLE,
  capturePlannerFor,
  plannerPolicySource,
  pricedCatalogValue,
  workerPolicySource,
  zeroPriceCatalogValue,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource
};

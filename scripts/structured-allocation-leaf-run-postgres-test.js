#!/usr/bin/env node
'use strict';

// Tranche 3 PostgreSQL suite: atomic leaf-run admission, exact item-to-Run
// binding, store-owned item-status derivation, deterministic aggregate
// completion, and the containment boundaries this tranche must not cross.
//
// No provider is contacted anywhere in this suite. Plan admission is driven
// directly against the store with a synthetic validated attempt, which is
// exactly the transaction production runs, and leaf admission is then exercised
// against the real PostgreSQL runtime.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  advancePlanningAttempt,
  createPlanningAttempt,
  buildPlannerRequestContext,
  buildPlannerRequestMessages,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  plannerRequestHash
} = require('../runtime/structured-allocation-planning-contract');
const {
  buildLeafDeclaredWorkSnapshot,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding,
  projectStructuredAllocationLeafExecution
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
} = require('../runtime/completion-decision-contract');
const { canonicalJson } = require('../runtime/declared-work-contract');
const { withHarness } = require('./postgres-test-harness');
const {
  governedAttemptState,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource
} = require('./governed-structured-fixture');

// Tranche 4 cutover. This suite's subject is Tranche 3 leaf behaviour, not
// economics, so it uses explicitly ZERO-PRICED governed authority: every
// routing, target and authority check still applies, but the accounting
// arithmetic is trivially zero and cannot distract from item reconciliation.
const LEAF_PLANNER_POLICY = zeroPricePlannerPolicySource();
const LEAF_WORKER_POLICY = zeroPriceWorkerPolicySource();

const STAMP = `${Date.now()}-${process.pid}`;
const ACTOR = 'structured-allocation-leaf-run-postgres-test';

// The parent declaration. `typedFamily` widens it with a ticket-authored
// typed-postcondition family so an item may legitimately carry one: the
// allocation-plan contract refuses any item capability the parent lacks, which
// is what makes the leaf typed-criterion refusal reachable at all.
function declaredWork(objective, { typedFamily = false } = {}) {
  const postcondition = { id: 'parent-report', type: 'fileExists', path: 'reports/report.md' };
  const declaration = canonicalJson(postcondition);
  const criterionHash = crypto.createHash('sha256').update(declaration).digest('hex');
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [
      { kind: 'text', declaration: 'Every report records concrete findings' },
      ...(typedFamily
        ? [{ kind: 'typed-postcondition', criterionType: 'fileExists', declaration, criterionHash }]
        : [])
    ],
    evidenceRequirements: typedFamily
      ? [{
        kind: 'postcondition-evidence',
        criterionHash,
        evidenceType: 'deterministic-postcondition-result'
      }]
      : []
  };
}

function ticketBody(group, objective, ownedOutputPaths, status = 'open') {
  const now = new Date().toISOString();
  return {
    objective,
    acceptanceCriteria: 'Review the explicit reports.',
    assignmentTargetType: 'group',
    assignmentTargetId: group.id,
    assignmentMode: 'allocated',
    ownedOutputPaths,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
      maxWorkspaceOperations: null, allowWorkspaceWrites: true,
      allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
    },
    status,
    blockedReason: null,
    createdBy: ACTOR,
    changedBy: ACTOR,
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function proposalFor(candidates, { typedItemAgentId = null } = {}) {
  return {
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: candidates.map(candidate => {
      const typed = candidate.agentId === typedItemAgentId;
      const postcondition = {
        id: `item-${candidate.agentId}`,
        type: 'fileExists',
        path: `${candidate.ownedOutputPaths[0]}report.md`
      };
      return {
        assignedAgentId: candidate.agentId,
        objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
        expectedOutputs: [{
          kind: 'text',
          declaration: `Findings report for ${candidate.ownedOutputPaths[0]}`
        }],
        successCriteria: [
          { kind: 'text', declaration: 'Report names at least one finding' },
          ...(typed
            ? [{
              kind: 'typed-postcondition',
              criterionType: 'fileExists',
              declaration: JSON.stringify(postcondition)
            }]
            : [])
        ],
        evidenceRequirements: []
      };
    })
  };
}

async function validatedAttempt(store, ticket, responseText, proposal) {
  const authority = ticket.structuredAllocationAuthority;
  const planning = authority.planningAuthoritySnapshot;
  const context = buildPlannerRequestContext(authority, { ticketId: ticket.id });
  const messages = buildPlannerRequestMessages(context);
  const requestHash = plannerRequestHash({
    provider: planning.planner.provider,
    model: planning.planner.model,
    messages
  });
  const responseHash = crypto.createHash('sha256').update(responseText).digest('hex');

  let attempt = createPlanningAttempt({
    attemptId: crypto.randomUUID(),
    ticketId: ticket.id,
    authority,
    createdAt: new Date().toISOString()
  });
  const write = async (patch, eventType) => {
    attempt = (await store.writeStructuredAllocationPlanningAttempt({
      ticketId: ticket.id,
      attempt: advancePlanningAttempt(attempt, patch),
      expectedAttemptStateHash: attempt.attemptStateHash,
      eventType
    })).attempt;
  };
  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt,
    expectedAttemptStateHash: null,
    eventType: 'ticket.structured_planning_started'
  })).attempt;
  const { governedExecution: leafPlannerGoverned } = await governedAttemptState(store, {
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    plannerAgentId: planning.planner.agentId,
    policy: LEAF_PLANNER_POLICY
  });
  await write({
    state: 'request_started',
    governedExecution: leafPlannerGoverned,
    requestHash,
    requestMetadata: {
      contextVersion: context.version,
      contextHash: context.contextHash,
      messageCount: messages.length,
      requestBytes: messages.reduce((total, message) => total + message.content.length, 0),
      timeoutMs: 120_000,
      maxResponseBytes: 262_144
    },
    requestStartedAt: new Date().toISOString()
  }, 'ticket.structured_planning_requested');
  await write({
    state: 'response_received',
    responseStatus: 'received',
    responseText,
    responseBytes: responseText.length,
    responseTruncated: false,
    responseHash
  }, 'ticket.structured_planning_responded');
  await write({
    state: 'proposal_validated',
    parseStatus: 'ok',
    validationStatus: 'ok',
    proposalHash: proposal.proposalHash
  }, 'ticket.structured_planning_validated');
  return attempt;
}

// The leaf run draft production builds: item-derived declared work, exact
// admitted ownership, ticket-derived completion authority, no allocation subtask.
function leafRunDraft(ticket, plan, item, agent, { completionAuthority = null } = {}) {
  const completionAuthoritySnapshot = completionAuthority || buildCompletionAuthoritySnapshot({
    objective: ticket.objective,
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required',
    directPostconditions: [],
    verificationPolicy: 'when_declared',
    capturedAt: new Date().toISOString()
  });
  return {
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    targetRef: null,
    workspaceRoot: '/tmp',
    mainWorkspaceRoot: '/tmp',
    executionWorkspaceType: 'main_owned_paths',
    executionPolicySnapshot: ticket.executionPolicy,
    completionAuthoritySnapshot,
    declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
      sharedConstraints: plan.sharedConstraints,
      completionAuthoritySnapshot
    }),
    acceptanceCriteriaSnapshot: null,
    allocationPlanId: plan.id,
    allocationItemId: item.allocationItemId,
    allocationSubtask: null,
    ownedOutputPaths: [...item.ownedOutputPaths],
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    currentPhase: 'planning',
    status: 'pending'
  };
}

// Drive a leaf run to a terminal state through the real lease lifecycle, exactly
// as the scheduler and runner do. Nothing here shortcuts the lease authority.
async function terminalizeRunTo(store, runId, status) {
  const claimed = await store.claimPendingRun({
    leaseOwner: ACTOR,
    leaseDurationMs: 600_000,
    eligibleRunIds: [runId]
  });
  assert.ok(claimed && claimed.run && claimed.run.id === runId,
    `run ${runId} could not be claimed for terminalization`);
  const running = (await store.startClaimedRun({
    runId,
    leaseOwner: ACTOR,
    leaseDurationMs: 600_000
  })).run;
  if (status === 'running') return running;
  return (await store.transitionRun({
    runId,
    expectedRevision: running.revision,
    fromStatuses: ['running'],
    toStatus: status,
    leaseOwner: ACTOR
  })).run;
}

function completionConsequence(run, disposition) {
  const base = {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    verification: { browserEvidence: null }
  };
  const replaySnapshot = {
    events: disposition === 'completed'
      ? [{ type: 'run:postcondition_completed', runId: run.id }]
      : [],
    modelResponses: [],
    parsedModelPlans: [],
    workspaceOperations: [],
    providerRequests: []
  };
  return {
    ...base,
    completionDecision: buildCompletionDecision({
      run: {
        ...run,
        status: disposition === 'completed' ? 'completed' : run.status,
        runtimeBudgetSnapshot: null
      },
      replaySnapshot,
      events: [],
      operations: [],
      consequence: base,
      verificationContract: null,
      evaluatedAt: new Date().toISOString()
    })
  };
}

// A run whose deterministic completion authority is satisfied reaches
// disposition `completed` through the canonical builder; nothing here forces it.
function verifiedCompletionAuthority(item) {
  return buildCompletionAuthoritySnapshot({
    objective: `Review ${item.ownedOutputPaths[0]} and record concrete findings`,
    kind: 'deterministic',
    recognized: true,
    intent: 'create_folder',
    completionPolicy: 'declared_postconditions',
    directPostconditions: [{
      type: 'folder_exists',
      path: item.ownedOutputPaths[0].replace(/\/$/, '')
    }],
    verificationPolicy: 'when_declared',
    capturedAt: new Date().toISOString()
  });
}

// Durable replay evidence that the item's declared folder postcondition really
// was checked and passed. The canonical decision builder evaluates it; nothing
// here forces a disposition.
function satisfiedConsequence(run, item) {
  const ownedPath = item.ownedOutputPaths[0].replace(/\/$/, '');
  const base = {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    verification: { browserEvidence: null }
  };
  return {
    ...base,
    completionDecision: buildCompletionDecision({
      run: { ...run, runtimeBudgetSnapshot: null },
      replaySnapshot: {
        events: [{
          type: 'run:postcondition_completed',
          checkedPaths: [{ type: 'folder', path: ownedPath }]
        }],
        modelResponses: [],
        parsedModelPlans: [],
        workspaceOperations: [],
        providerRequests: []
      },
      events: [],
      operations: [],
      consequence: base,
      verificationContract: null,
      evaluatedAt: new Date().toISOString()
    })
  };
}

// One decision builder for every terminal-gate fixture. The completion decision
// is always produced by the canonical builder from real evidence; the only
// variables are WHICH completion authority it is evaluated against and whether
// the postcondition evidence satisfies it.
//
//   authority === the run's own + satisfying evidence   -> completed
//   authority === the run's own + no evidence           -> blocked
//   authority === the run's own + wrong-path evidence   -> incomplete
//   authority === another item's                        -> hash mismatch, so the
//                                                          leaf derivation refuses
//                                                          whatever the disposition
function decisionConsequence(run, { authority, checkedPath = null }) {
  const base = {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    verification: { browserEvidence: null }
  };
  return {
    ...base,
    completionDecision: buildCompletionDecision({
      run: { ...run, completionAuthoritySnapshot: authority, runtimeBudgetSnapshot: null },
      replaySnapshot: {
        events: checkedPath === null
          ? []
          : [{
            type: 'run:postcondition_completed',
            checkedPaths: [{ type: 'folder', path: checkedPath }]
          }],
        modelResponses: [],
        parsedModelPlans: [],
        workspaceOperations: [],
        providerRequests: []
      },
      events: [],
      operations: [],
      consequence: base,
      verificationContract: null,
      evaluatedAt: new Date().toISOString()
    })
  };
}

function ownedFolder(item) {
  return item.ownedOutputPaths[0].replace(/\/$/, '');
}

async function main() {
  await withHarness('structured allocation leaf-run PostgreSQL', async ({ store }) => {
    const group = (await store.createGroup({
      value: { name: `Leaf Admission ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const planner = (await store.createConfiguredAgent({
      value: { name: `Planner ${STAMP}`, provider: 'openai', model: 'gpt-planner-test', apiKey: '' },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const worker = (await store.createConfiguredAgent({
      value: { name: `Worker ${STAMP}`, provider: 'openai', model: 'gpt-worker-test', apiKey: '' },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const designated = (await store.updateGroup({
      groupId: group.id,
      expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id },
      changedBy: ACTOR
    })).group;

    const ownedOutputPaths = {
      [planner.id]: 'reports/planner/',
      [worker.id]: 'reports/worker/'
    };
    const agentById = new Map([[planner.id, planner], [worker.id, worker]]);

    const admitPlan = async (objective, { typedItemAgentId = null } = {}) => {
      const catalog = await store.getConfiguredAgentsByIds({ agentIds: [planner.id, worker.id] });
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork: declaredWork(objective, { typedFamily: typedItemAgentId !== null }),
        ticketObjective: objective,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog.find(agent => agent.id === planner.id),
        candidateAgents: catalog,
        ownedOutputPaths
      });
      const ticket = (await store.createTicketWithEvent({
        ticket: ticketBody(designated, objective, ownedOutputPaths),
        structuredAllocationAuthorityDraft: authorityDraft,
        eventPayload: { source: ACTOR }
      })).ticket;
      const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
      const responseText = JSON.stringify(proposalFor(planning.candidates, { typedItemAgentId }));
      const proposal = normalizePlannerProposal(JSON.parse(responseText));
      const planDraft = lowerPlannerProposalToAllocationPlanDraft({
        ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        proposal
      });
      const attempt = await validatedAttempt(store, ticket, responseText, proposal);
      const admission = await store.admitStructuredAllocationPlan({
        ticketId: ticket.id,
        attempt,
        allocationPlanDraft: planDraft,
        plannerCredentialsAvailable: true,
        eventPayload: { source: ACTOR }
      });
      assert.equal(admission.admitted, true);
      return { ticket: await store.getTicket(ticket.id), plan: admission.plan };
    };

    const draftsFor = (ticket, plan, options = {}) => plan.items.map(item => ({
      allocationItemId: item.allocationItemId,
      run: leafRunDraft(ticket, plan, item, agentById.get(item.assignedAgentId), options)
    }));

    // ── One Run per item, admitted atomically ────────────────────────────────
    const primary = await admitPlan(`Admit structured leaf runs ${STAMP}`);
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: primary.ticket.id, limit: 20 })).runs,
      [],
      'plan admission alone still creates zero worker runs'
    );

    const admission = await store.admitStructuredAllocationLeafRuns({
      ticketId: primary.ticket.id,
      allocationPlanId: primary.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: draftsFor(primary.ticket, primary.plan),
      eventPayload: { source: ACTOR }
    });
    assert.equal(admission.admitted, true);
    assert.equal(admission.runs.length, primary.plan.items.length,
      'exactly one initial Run per immutable allocation item');
    assert.equal(new Set(admission.runs.map(run => run.allocationItemId)).size,
      primary.plan.items.length, 'each item is bound exactly once');

    // ── Exact item-to-Run bindings ───────────────────────────────────────────
    const itemsById = new Map(primary.plan.items.map(item => [item.allocationItemId, item]));
    for (const run of admission.runs) {
      const item = itemsById.get(run.allocationItemId);
      const binding = normalizeLeafRunBinding(run.leafRunBinding, {
        expectedRunId: run.id,
        expectedTicketId: primary.ticket.id,
        expectedPlanId: primary.plan.id,
        expectedPlanHash: primary.plan.planHash,
        expectedAllocationItemId: item.allocationItemId
      });
      assert.equal(binding.assignedAgentId, item.assignedAgentId,
        'the worker principal is the agent the item admitted');
      assert.equal(run.agentId, item.assignedAgentId,
        'the Run is dispatched to the admitted agent, never a replacement');
      assert.deepEqual(binding.ownedOutputPaths, item.ownedOutputPaths,
        'ownership is the exact admitted item ownership');
      assert.deepEqual(run.ownedOutputPaths, item.ownedOutputPaths,
        'the Run carries the exact admitted owned paths');
      assert.equal(binding.parentDeclaredWorkHash,
        primary.plan.parentDeclaredWorkSnapshot.contractHash);
      assert.equal(binding.planningAttemptId, primary.plan.planningProvenance.attemptId);
      assert.equal(binding.planningAdmissionHash, primary.plan.planningProvenance.admissionHash);
      assert.equal(binding.runId, run.id, 'the binding carries its runtime-assigned Run ID');

      // Declared work comes from the item, not from the parent Ticket, and the
      // generic v1 allocation subtask is absent entirely.
      assert.equal(run.declaredWorkSnapshot.contractHash, binding.itemDeclaredWorkHash,
        'the Run declares exactly the work its binding records');
      assert.equal(run.declaredWorkSnapshot.objective.text, item.objective.text,
        'the leaf objective is the allocation item objective');
      assert.notEqual(run.declaredWorkSnapshot.objective.text, primary.ticket.objective,
        'the leaf objective is not the parent ticket objective');
      assert.notEqual(run.declaredWorkSnapshot.contractHash,
        primary.plan.parentDeclaredWorkSnapshot.contractHash);
      assert.equal(run.allocationSubtask ?? null, null,
        'no generic allocation subtask is produced');
      assert.equal(canonicalJson(run.declaredWorkSnapshot).includes('allocated output for ticket'),
        false, 'the v1 placeholder sentence never reaches a leaf declaration');
      assert.equal(
        run.declaredWorkSnapshot.successCriteria.some(criterion =>
          criterion.declaration === 'Stay inside your own folder'),
        true,
        'admitted shared constraints are carried onto every leaf'
      );
    }
    assert.equal(
      new Set(admission.runs.map(run => run.leafRunBinding.bindingHash)).size,
      admission.runs.length,
      'every leaf binding hash is distinct'
    );
    assert.equal(
      new Set(admission.runs.map(run => run.declaredWorkSnapshot.contractHash)).size,
      admission.runs.length,
      'sibling leaves declare distinct work'
    );

    // ── Worker route is distinct from the planner route ──────────────────────
    const plannerRun = admission.runs.find(run => run.agentId === planner.id);
    assert.ok(plannerRun, 'the planner agent is also a captured candidate and gets a worker run');
    assert.equal(plannerRun.capabilityId, 'agent-selected-actions',
      'leaf runs use the existing worker capability route');
    const admittedTicket = await store.getTicket(primary.ticket.id);
    assert.equal(admittedTicket.structuredAllocationPlanningAttempt.state, 'plan_admitted');
    assert.equal(
      admittedTicket.structuredAllocationAuthority.planningAuthoritySnapshot.planner.agentId,
      planner.id,
      'the planning route is a separate captured principal and is unchanged'
    );
    assert.equal(
      admittedTicket.structuredAllocationPlanningAttempt.planner.model,
      'gpt-planner-test',
      'the planner model remains the planning route, not a worker route'
    );

    // ── Scheduler sees the runs only after commit, and all together ──────────
    const pending = await store.listPendingRuns({ limit: 100 });
    const visible = pending.runs.filter(run => run.ticketId === primary.ticket.id);
    assert.equal(visible.length, admission.runs.length,
      'every leaf run becomes scheduler-visible together');
    assert.equal(visible.every(run => Boolean(run.leafRunBinding)), true,
      'no leaf run is scheduler-visible without its immutable binding');
    assert.equal((await store.getTicket(primary.ticket.id)).status, 'in_progress');

    const leafEvents = (await store.listTicketEvents(primary.ticket.id, { limit: 100 })).events;
    const leafEvent = leafEvents.find(event => event.type === 'ticket.allocation_leaf_runs_admitted');
    assert.ok(leafEvent, 'leaf admission appends its event');
    assert.equal(leafEvent.payload.workerRunsCreated, admission.runs.length);
    assert.equal(leafEvent.payload.leafBindings.length, admission.runs.length);
    assert.equal(
      leafEvents.filter(event => event.type === 'ticket.allocation_leaf_runs_admitted').length,
      1,
      'leaf admission is evidenced exactly once'
    );

    // ── Idempotent re-admission creates no duplicate ─────────────────────────
    const repeat = await store.admitStructuredAllocationLeafRuns({
      ticketId: primary.ticket.id,
      allocationPlanId: primary.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: draftsFor(primary.ticket, primary.plan)
    });
    assert.equal(repeat.admitted, false, 'a committed leaf set re-reports itself');
    assert.deepEqual(repeat.runs.map(run => run.id).sort(), admission.runs.map(run => run.id).sort());
    assert.equal(
      (await store.listRunsForTicket({ ticketId: primary.ticket.id, limit: 50 })).runs.length,
      admission.runs.length,
      'no duplicate leaf run is created'
    );

    // ── Concurrent admission cannot duplicate ────────────────────────────────
    const concurrent = await admitPlan(`Concurrent leaf admission ${STAMP}`);
    const concurrentDrafts = draftsFor(concurrent.ticket, concurrent.plan);
    const outcomes = await Promise.allSettled([
      store.admitStructuredAllocationLeafRuns({
        ticketId: concurrent.ticket.id,
        allocationPlanId: concurrent.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: concurrentDrafts
      }),
      store.admitStructuredAllocationLeafRuns({
        ticketId: concurrent.ticket.id,
        allocationPlanId: concurrent.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: concurrentDrafts
      })
    ]);
    const admittedOnce = outcomes.filter(outcome =>
      outcome.status === 'fulfilled' && outcome.value.admitted === true);
    assert.equal(admittedOnce.length, 1, 'exactly one concurrent admission wins');
    const concurrentRuns =
      (await store.listRunsForTicket({ ticketId: concurrent.ticket.id, limit: 50 })).runs;
    assert.equal(concurrentRuns.length, concurrent.plan.items.length,
      'concurrent admission cannot duplicate the leaf set');
    assert.equal(
      new Set(concurrentRuns.map(run => run.leafRunBinding.allocationItemId)).size,
      concurrent.plan.items.length,
      'no allocation item receives two initial bindings'
    );

    // ── Typed model-provenance criteria refuse the entire admission ──────────
    const typedPlan = await admitPlan(`Typed criteria refusal ${STAMP}`, {
      typedItemAgentId: worker.id
    });
    assert.equal(
      typedPlan.plan.items.some(item =>
        item.successCriteria.some(criterion => criterion.kind === 'typed-postcondition')),
      true,
      'the admitted plan really does carry a model-provenance typed criterion'
    );
    const textOnlyItem = typedPlan.plan.items.find(item =>
      item.successCriteria.every(criterion => criterion.kind === 'text'));
    const typedItem = typedPlan.plan.items.find(item =>
      item.successCriteria.some(criterion => criterion.kind === 'typed-postcondition'));
    assert.equal(
      typedItem.successCriteria.find(criterion => criterion.kind === 'typed-postcondition')
        .provenance,
      'validated-model-contract',
      'the typed criterion carries model provenance, which admits no completion authority'
    );
    // The typed item's declared work is not constructible at all, so its draft
    // borrows the text-only sibling's declaration. Preflight must still refuse
    // on the typed criterion, and must refuse the WHOLE admission rather than
    // admitting the text-only sibling.
    await assert.rejects(
      () => store.admitStructuredAllocationLeafRuns({
        ticketId: typedPlan.ticket.id,
        allocationPlanId: typedPlan.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: [
          {
            allocationItemId: textOnlyItem.allocationItemId,
            run: leafRunDraft(typedPlan.ticket, typedPlan.plan, textOnlyItem,
              agentById.get(textOnlyItem.assignedAgentId))
          },
          {
            allocationItemId: typedItem.allocationItemId,
            run: {
              ...leafRunDraft(typedPlan.ticket, typedPlan.plan, textOnlyItem,
                agentById.get(typedItem.assignedAgentId)),
              agentId: typedItem.assignedAgentId,
              allocationItemId: typedItem.allocationItemId,
              ownedOutputPaths: [...typedItem.ownedOutputPaths]
            }
          }
        ]
      }),
      error => error.reason === 'leaf_item_typed_criteria_unsupported',
      'a typed model-provenance criterion refuses the entire leaf admission'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: typedPlan.ticket.id, limit: 20 })).runs,
      [],
      'a refused admission creates zero Runs and zero bindings'
    );
    const preservedPlan = await store.getAllocationPlan(typedPlan.plan.id);
    assert.equal(preservedPlan.planHash, typedPlan.plan.planHash,
      'the admitted plan is preserved by a refusal');
    assert.equal(preservedPlan.status, 'pending');

    // ── Rollback leaves zero Runs and zero bindings ──────────────────────────
    const rollback = await admitPlan(`Leaf admission rollback ${STAMP}`);
    const rollbackDrafts = draftsFor(rollback.ticket, rollback.plan);
    await assert.rejects(
      () => store.admitStructuredAllocationLeafRuns({
        ticketId: rollback.ticket.id,
        allocationPlanId: rollback.plan.id,
        // The second draft names an agent the item never admitted, so the whole
        // transaction must roll back rather than persist the first.
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: [
          rollbackDrafts[0],
          {
            ...rollbackDrafts[1],
            run: { ...rollbackDrafts[1].run, agentId: rollbackDrafts[0].run.agentId }
          }
        ]
      }),
      error => error.reason === 'leaf_agent_not_authorized'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: rollback.ticket.id, limit: 20 })).runs,
      [],
      'a rolled-back admission leaves zero Runs and zero bindings'
    );
    // Ownership drift refuses too, and equally atomically.
    await assert.rejects(
      () => store.admitStructuredAllocationLeafRuns({
        ticketId: rollback.ticket.id,
        allocationPlanId: rollback.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: [
          rollbackDrafts[0],
          {
            ...rollbackDrafts[1],
            run: { ...rollbackDrafts[1].run, ownedOutputPaths: ['reports/elsewhere/'] }
          }
        ]
      }),
      error => error.reason === 'leaf_ownership_drift'
    );
    // A partial leaf set is refused: leaf admission is one item per plan item.
    await assert.rejects(
      () => store.admitStructuredAllocationLeafRuns({
        ticketId: rollback.ticket.id,
        allocationPlanId: rollback.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: [rollbackDrafts[0]]
      }),
      error => error.reason === 'leaf_ownership_drift'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: rollback.ticket.id, limit: 20 })).runs,
      [],
      'no partial leaf set is ever persisted'
    );
    assert.equal((await store.getTicket(rollback.ticket.id)).status, 'open',
      'a refused admission does not start the parent ticket');

    // ── A raw completed Run cannot complete an item ──────────────────────────
    const [firstRun, secondRun] = admission.runs;
    await terminalizeRunTo(store, firstRun.id, 'completed');
    let reconciled = await store.reconcileStructuredAllocationLeafItems({
      ticketId: primary.ticket.id,
      allocationPlanId: primary.plan.id
    });
    assert.equal(reconciled.reconciled, true);
    const rawCompletedItem = reconciled.decision.items.find(item =>
      item.runId === firstRun.id);
    assert.notEqual(rawCompletedItem.itemStatus, 'completed',
      'a terminal completed Run with no durable decision never completes its item');
    assert.equal(rawCompletedItem.itemStatus, 'interrupted');
    assert.equal(rawCompletedItem.reason, 'completion_decision_missing');
    assert.equal(rawCompletedItem.completionDecisionHash, null);
    assert.notEqual(reconciled.decision.aggregateStatus, 'completed');
    assert.equal((await store.getAllocationPlan(primary.plan.id)).status,
      reconciled.decision.aggregateStatus);

    // The caller cannot supply or force the derived status.
    await assert.rejects(
      () => store.updateAllocationItemStatus({
        planId: primary.plan.id,
        allocationItemId: firstRun.allocationItemId,
        status: 'completed'
      }),
      error => error.code === 'ALLOCATION_ITEM_STATUS_NOT_CALLER_OWNED',
      'a caller may request reconciliation but may not supply an item status'
    );
    assert.equal(
      (await store.getAllocationPlan(primary.plan.id)).items
        .find(item => item.allocationItemId === firstRun.allocationItemId).status,
      'interrupted',
      'the refused caller write changed nothing'
    );

    // ── Repeated reconciliation is idempotent ────────────────────────────────
    const planBefore = await store.getAllocationPlan(primary.plan.id);
    const again = await store.reconcileStructuredAllocationLeafItems({
      ticketId: primary.ticket.id,
      allocationPlanId: primary.plan.id
    });
    assert.equal(again.changed, false, 'unchanged facts write nothing');
    const planAfter = await store.getAllocationPlan(primary.plan.id);
    assert.equal(planAfter.revision, planBefore.revision,
      'idempotent reconciliation does not bump the plan revision');
    assert.equal(planAfter.aggregateDecision.decisionHash,
      planBefore.aggregateDecision.decisionHash);

    // ── A valid durable decision completes exactly its own item ──────────────
    await store.recordRunConsequence({
      runId: firstRun.id,
      consequence: completionConsequence(await store.getRun(firstRun.id), 'completed')
    });
    reconciled = await store.reconcileStructuredAllocationLeafItems({
      ticketId: primary.ticket.id,
      allocationPlanId: primary.plan.id
    });
    const decidedFirst = reconciled.decision.items.find(item => item.runId === firstRun.id);
    // This objective is model-driven, so the canonical decision builder cannot
    // report completion for it. The item therefore stays unresolved, which is
    // exactly the fail-closed rule: only a decision that says `completed` completes.
    assert.equal(decidedFirst.itemStatus === 'completed', false,
      'a decision that does not say completed cannot complete an item');
    assert.equal(reconciled.decision.aggregateStatus === 'completed', false);

    // ── Full aggregate completion requires every item ────────────────────────
    const completing = await admitPlan(`Aggregate completion ${STAMP}`);
    const completingAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: completing.ticket.id,
      allocationPlanId: completing.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: completing.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          completing.ticket, completing.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    assert.equal(completingAdmission.runs.length, completing.plan.items.length);
    const completingItems = new Map(
      completing.plan.items.map(item => [item.allocationItemId, item]));

    // Complete only the first item.
    const runA = completingAdmission.runs[0];
    const runB = completingAdmission.runs[1];
    await terminalizeRunTo(store, runA.id, 'completed');
    await store.recordRunConsequence({
      runId: runA.id,
      consequence: satisfiedConsequence(
        await store.getRun(runA.id),
        completingItems.get(runA.allocationItemId)
      )
    });
    let aggregate = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: completing.ticket.id,
      allocationPlanId: completing.plan.id
    })).decision;
    const itemA = aggregate.items.find(item => item.runId === runA.id);
    assert.equal(itemA.itemStatus, 'completed',
      'a valid durable successful decision completes its item');
    assert.equal(itemA.reason, 'completion_verified');
    assert.match(itemA.completionDecisionHash, /^[0-9a-f]{64}$/,
      'the completion-decision identity supporting the item is recorded');
    assert.notEqual(aggregate.aggregateStatus, 'completed',
      'aggregate completion requires every required item');
    assert.deepEqual(aggregate.completedItemIds, [itemA.allocationItemId]);
    assert.deepEqual(aggregate.unresolvedItemIds, [
      aggregate.items.find(item => item.runId === runB.id).allocationItemId
    ]);

    // Now complete the second item too.
    await terminalizeRunTo(store, runB.id, 'completed');
    await store.recordRunConsequence({
      runId: runB.id,
      consequence: satisfiedConsequence(
        await store.getRun(runB.id),
        completingItems.get(runB.allocationItemId)
      )
    });
    aggregate = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: completing.ticket.id,
      allocationPlanId: completing.plan.id
    })).decision;
    assert.equal(aggregate.aggregateStatus, 'completed',
      'the plan completes only when every item has a valid completed decision');
    assert.equal(aggregate.completedItemIds.length, completing.plan.items.length);
    assert.deepEqual(aggregate.unresolvedItemIds, []);
    assert.deepEqual(aggregate.failedItemIds, []);
    const completedPlan = await store.getAllocationPlan(completing.plan.id);
    assert.equal(completedPlan.status, 'completed');
    // The reconciliation write re-serializes the whole plan body, so it must
    // carry durable admission provenance and immutable authority forward intact.
    assert.equal(completedPlan.planHash, completing.plan.planHash,
      'reconciliation never alters plan authority');
    assert.equal(completedPlan.planningProvenance.provenanceHash,
      completing.plan.planningProvenance.provenanceHash);
    assert.equal(completedPlan.planningProvenance.admissionHash,
      completing.plan.planningProvenance.admissionHash,
      'reconciliation preserves the admission binding');
    assert.deepEqual(
      completedPlan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        assignedAgentId: item.assignedAgentId,
        ownedOutputPaths: item.ownedOutputPaths
      })),
      completing.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        assignedAgentId: item.assignedAgentId,
        ownedOutputPaths: item.ownedOutputPaths
      })),
      'reconciliation rewrites no item authority'
    );
    assert.equal(completedPlan.items.every(item => item.status === 'completed'), true);
    normalizeAggregatePlanDecision(completedPlan.aggregateDecision, {
      expectedPlanHash: completedPlan.planHash,
      expectedPlanId: completedPlan.id
    });

    // ── Parent completion through the canonical transaction, exactly once ────
    const parentBefore = await store.getTicket(completing.ticket.id);
    assert.equal(parentBefore.status, 'in_progress');
    const transitioned = await store.transitionTicketAfterRun({ runId: runB.id });
    assert.equal(transitioned.changed, true);
    assert.equal(transitioned.ticket.status, 'completed',
      'the parent Ticket completes through the canonical transition');
    const repeatTransition = await store.transitionTicketAfterRun({ runId: runB.id });
    assert.equal(repeatTransition.changed, false,
      'the parent completion is not re-applied');
    // Ticket-level status events only: run events carry their own `status`.
    const completionEvents = (await store.listTicketEvents(completing.ticket.id, { limit: 200 }))
      .events.filter(event =>
        (event.runId === null || event.runId === undefined) &&
        event.payload && event.payload.status === 'completed' &&
        event.payload.previousStatus && event.payload.previousStatus !== 'completed');
    assert.equal(completionEvents.length, 1,
      'the parent completion event is emitted exactly once');
    assert.equal(completionEvents[0].payload.previousStatus, 'in_progress');

    // Reconciliation stays idempotent after parent completion.
    const settled = await store.reconcileStructuredAllocationLeafItems({
      ticketId: completing.ticket.id,
      allocationPlanId: completing.plan.id
    });
    assert.equal(settled.changed, false);
    assert.equal(settled.decision.aggregateStatus, 'completed');

    // ── The parent transition CONSUMES the aggregate proof ───────────────────
    //
    // Ordering: no path may transition the Ticket first and persist the
    // aggregate later. transitionTicketAfterRun reconciles the planner-admitted
    // plan inside its own transaction, so the aggregate is always durable before
    // any parent status change that depends on it.
    const ordering = await admitPlan(`Aggregate ordering ${STAMP}`);
    const orderingAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: ordering.ticket.id,
      allocationPlanId: ordering.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: ordering.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          ordering.ticket, ordering.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const orderingItems = new Map(ordering.plan.items.map(item => [item.allocationItemId, item]));
    const [orderingFirst, orderingLast] = orderingAdmission.runs;
    for (const run of [orderingFirst, orderingLast]) {
      await terminalizeRunTo(store, run.id, 'completed');
      await store.recordRunConsequence({
        runId: run.id,
        consequence: satisfiedConsequence(
          await store.getRun(run.id),
          orderingItems.get(run.allocationItemId)
        )
      });
    }
    // No reconciliation has been requested at all: the plan still holds no
    // aggregate decision, and both leaf runs are already durably completed.
    assert.equal((await store.getAllocationPlan(ordering.plan.id)).aggregateDecision ?? null, null);
    assert.equal((await store.getTicket(ordering.ticket.id)).status, 'in_progress');

    const orderingTransition = await store.transitionTicketAfterRun({ runId: orderingLast.id });
    assert.equal(orderingTransition.ticket.status, 'completed');
    const orderingPlan = await store.getAllocationPlan(ordering.plan.id);
    assert.notEqual(orderingPlan.aggregateDecision ?? null, null,
      'the parent transition cannot complete without a durable aggregate decision');
    assert.equal(orderingPlan.aggregateDecision.aggregateStatus, 'completed');
    assert.equal(orderingTransition.aggregateDecision.decisionHash,
      orderingPlan.aggregateDecision.decisionHash,
      'the transition reports the exact aggregate decision that authorized it');
    // The completed parent event names its plan and its proof.
    const orderingEvents = (await store.listTicketEvents(ordering.ticket.id, { limit: 200 })).events;
    const orderingCompletion = orderingEvents.filter(event =>
      (event.runId === null || event.runId === undefined) &&
      event.payload && event.payload.status === 'completed' &&
      event.payload.previousStatus && event.payload.previousStatus !== 'completed');
    assert.equal(orderingCompletion.length, 1,
      'the parent completion event is emitted exactly once');
    assert.equal(orderingCompletion[0].payload.allocationPlanId, ordering.plan.id,
      'the completed parent event identifies its allocation plan');
    assert.equal(orderingCompletion[0].payload.aggregateDecisionHash,
      orderingPlan.aggregateDecision.decisionHash,
      'the completed parent event identifies the aggregate decision hash');
    // The reconciliation write is journalled in the same transaction.
    const reconciliationEvents = orderingEvents.filter(event =>
      event.type === 'ticket.allocation_leaf_items_reconciled');
    assert.equal(reconciliationEvents.length >= 1, true,
      'reconciliation appends a canonical event');
    const lastReconciliation = reconciliationEvents[reconciliationEvents.length - 1];
    assert.equal(lastReconciliation.payload.aggregateDecisionHash,
      orderingPlan.aggregateDecision.decisionHash);
    assert.equal(lastReconciliation.payload.allocationPlanId, ordering.plan.id);
    assert.equal(Array.isArray(lastReconciliation.payload.changedItems), true);
    // Repeating the transition performs no write and emits no duplicate event.
    const repeatTransitionOrdering = await store.transitionTicketAfterRun({ runId: orderingLast.id });
    assert.equal(repeatTransitionOrdering.changed, false);
    assert.equal(
      (await store.listTicketEvents(ordering.ticket.id, { limit: 200 })).events
        .filter(event => event.type === 'ticket.allocation_leaf_items_reconciled').length,
      reconciliationEvents.length,
      'repeated reconciliation over unchanged facts emits no duplicate event'
    );

    // ── A raw completed Run set cannot complete the parent without proof ─────
    //
    // Every leaf Run is terminal `completed` and every completion decision says
    // completed, but one decision was evaluated against different completion
    // authority. The batch projection alone would complete the Ticket; the leaf
    // proof refuses, so the Ticket must not complete.
    const unproven = await admitPlan(`Aggregate refuses unproven completion ${STAMP}`);
    const unprovenAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: unproven.ticket.id,
      allocationPlanId: unproven.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: unproven.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          unproven.ticket, unproven.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const unprovenItems = new Map(unproven.plan.items.map(item => [item.allocationItemId, item]));
    const provenRun = unprovenAdmission.runs[0];
    const forgedRun = unprovenAdmission.runs[1];
    await terminalizeRunTo(store, provenRun.id, 'completed');
    await store.recordRunConsequence({
      runId: provenRun.id,
      consequence: satisfiedConsequence(
        await store.getRun(provenRun.id),
        unprovenItems.get(provenRun.allocationItemId)
      )
    });
    await terminalizeRunTo(store, forgedRun.id, 'completed');
    // A decision that genuinely reports `completed` for the right run and the
    // right ticket, and therefore satisfies transitionTicketAfterRun's own
    // projection — but which was EVALUATED against different completion
    // authority than the Run durably holds. Only the leaf derivation checks
    // that, which is precisely the divergence this gate exists for.
    const forgedPersisted = await store.getRun(forgedRun.id);
    const foreignAuthority = verifiedCompletionAuthority(
      unprovenItems.get(provenRun.allocationItemId)
    );
    assert.notEqual(
      foreignAuthority.objectiveContractHash,
      forgedPersisted.completionAuthoritySnapshot.objectiveContractHash,
      'the fixture really does evaluate against different completion authority'
    );
    const forgedBase = {
      version: 1,
      runId: forgedPersisted.id,
      ticketId: forgedPersisted.ticketId,
      verification: { browserEvidence: null }
    };
    const forgedDecision = buildCompletionDecision({
      run: {
        ...forgedPersisted,
        completionAuthoritySnapshot: foreignAuthority,
        runtimeBudgetSnapshot: null
      },
      replaySnapshot: {
        events: [{
          type: 'run:postcondition_completed',
          checkedPaths: [{
            type: 'folder',
            path: unprovenItems.get(provenRun.allocationItemId)
              .ownedOutputPaths[0].replace(/\/$/, '')
          }]
        }],
        modelResponses: [],
        parsedModelPlans: [],
        workspaceOperations: [],
        providerRequests: []
      },
      events: [],
      operations: [],
      consequence: forgedBase,
      verificationContract: null,
      evaluatedAt: new Date().toISOString()
    });
    assert.equal(forgedDecision.completionDisposition, 'completed',
      'the forged decision really does claim completion');
    assert.equal(forgedDecision.runId, forgedPersisted.id);
    assert.equal(forgedDecision.ticketId, forgedPersisted.ticketId);
    assert.notEqual(forgedDecision.objectiveContractHash,
      forgedPersisted.completionAuthoritySnapshot.objectiveContractHash);
    await store.recordRunConsequence({
      runId: forgedRun.id,
      consequence: { ...forgedBase, completionDecision: forgedDecision }
    });
    const unprovenAggregate = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: unproven.ticket.id,
      allocationPlanId: unproven.plan.id
    })).decision;
    const forgedItem = unprovenAggregate.items.find(item => item.runId === forgedRun.id);
    assert.equal(forgedItem.itemStatus, 'interrupted');
    assert.equal(forgedItem.reason, 'completion_authority_mismatch');
    assert.equal(forgedItem.completionDecisionHash, null);
    assert.notEqual(unprovenAggregate.aggregateStatus, 'completed',
      'a decision evaluated against other completion authority cannot complete an item');
    const unprovenTransition = await store.transitionTicketAfterRun({ runId: forgedRun.id });
    assert.notEqual(unprovenTransition.ticket.status, 'completed',
      'the parent cannot complete while the aggregate proof refuses');
    assert.equal(
      (await store.getAllocationPlan(unproven.plan.id)).aggregateDecision.aggregateStatus,
      unprovenAggregate.aggregateStatus,
      'the refused transition still leaves a durable, validated aggregate'
    );

    // ── Rollback around the final sibling completion ─────────────────────────
    //
    // The parent transition and the aggregate write share one transaction, so a
    // failure after the aggregate write must leave BOTH untouched.
    const rollbackFinal = await admitPlan(`Final sibling rollback ${STAMP}`);
    const rollbackFinalAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: rollbackFinal.ticket.id,
      allocationPlanId: rollbackFinal.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: rollbackFinal.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          rollbackFinal.ticket, rollbackFinal.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const rollbackFinalItems = new Map(
      rollbackFinal.plan.items.map(item => [item.allocationItemId, item]));
    for (const run of rollbackFinalAdmission.runs) {
      await terminalizeRunTo(store, run.id, 'completed');
      await store.recordRunConsequence({
        runId: run.id,
        consequence: satisfiedConsequence(
          await store.getRun(run.id),
          rollbackFinalItems.get(run.allocationItemId)
        )
      });
    }
    const finalRun = rollbackFinalAdmission.runs[1];
    const planBeforeRollback = await store.getAllocationPlan(rollbackFinal.plan.id);
    const ticketBeforeRollback = await store.getTicket(rollbackFinal.ticket.id);
    assert.equal(planBeforeRollback.aggregateDecision ?? null, null);
    await assert.rejects(
      () => store.withTransaction(async client => {
        const inner = await store.transitionTicketAfterRun({ runId: finalRun.id }, { client });
        assert.equal(inner.ticket.status, 'completed');
        assert.equal(inner.aggregateDecision.aggregateStatus, 'completed');
        const error = new Error('injected failure after the parent transition');
        error.code = 'TEST_INJECTED_ROLLBACK';
        throw error;
      }),
      error => error.code === 'TEST_INJECTED_ROLLBACK'
    );
    const planAfterRollback = await store.getAllocationPlan(rollbackFinal.plan.id);
    const ticketAfterRollback = await store.getTicket(rollbackFinal.ticket.id);
    assert.equal(planAfterRollback.aggregateDecision ?? null, null,
      'rollback leaves no aggregate decision');
    assert.equal(planAfterRollback.revision, planBeforeRollback.revision,
      'rollback bumps no plan revision');
    assert.equal(ticketAfterRollback.status, ticketBeforeRollback.status,
      'rollback leaves the parent ticket status untouched');
    assert.equal(
      (await store.listTicketEvents(rollbackFinal.ticket.id, { limit: 200 })).events
        .some(event => event.type === 'ticket.allocation_leaf_items_reconciled'),
      false,
      'a rolled-back reconciliation emits no event claiming a transition that did not commit'
    );
    // Replaying it for real now commits both together.
    const committedFinal = await store.transitionTicketAfterRun({ runId: finalRun.id });
    assert.equal(committedFinal.ticket.status, 'completed');
    assert.equal(
      (await store.getAllocationPlan(rollbackFinal.plan.id)).aggregateDecision.aggregateStatus,
      'completed',
      'a crash before commit is deterministically recoverable by retrying the same transition'
    );

    // ── Reserved Run identity is not caller data ─────────────────────────────
    const identityTicket = (await store.createTicketWithEvent({
      ticket: ticketBody(designated, `Run identity confinement ${STAMP}`, ownedOutputPaths),
      eventPayload: { source: ACTOR }
    })).ticket;
    await assert.rejects(
      () => store.createRun({
        id: 999999,
        ticketId: identityTicket.id,
        agentId: worker.id,
        status: 'pending'
      }),
      error => error.code === 'RUN_IDENTITY_NOT_CALLER_OWNED',
      'a caller cannot select a Run identity through the record'
    );
    await assert.rejects(
      () => store.createRunsAndStartTicket({
        ticketId: identityTicket.id,
        runDrafts: [{ id: 999998, ticketId: identityTicket.id, agentId: worker.id }]
      }),
      error => error.code === 'RUN_IDENTITY_NOT_CALLER_OWNED',
      'a run draft cannot smuggle a Run identity through the batch admission path'
    );
    await assert.rejects(
      () => store.createRunsAndStartTicket({
        ticketId: identityTicket.id,
        runDrafts: [{ ticketId: identityTicket.id, agentId: worker.id }]
      }, { reservedRunIds: [999997] }),
      error => /reserving transaction/.test(error.message),
      'reserved identities are refused outside the reserving transaction'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: identityTicket.id, limit: 20 })).runs,
      [],
      'every refused identity injection created no run'
    );
    // Ordinary admission still assigns identities from the sequence.
    assert.equal(
      admission.runs.every(run => Number.isSafeInteger(run.id) && run.id > 0),
      true
    );

    // ── EVERY terminal parent outcome is gated by the aggregate proof ────────
    //
    // Gating only `completed` left the failure paths as parallel authorities.
    // These fixtures drive the canonical projection to `blocked` and to `failed`
    // while the aggregate says the leaf set is unresolved, and require the parent
    // to stay nonterminal in both.
    const terminalGateCase = async (label, { foreignAuthority, checkedPath }) => {
      const scenario = await admitPlan(`${label} ${STAMP}`);
      const admitted = await store.admitStructuredAllocationLeafRuns({
        ticketId: scenario.ticket.id,
        allocationPlanId: scenario.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: scenario.plan.items.map(item => ({
          allocationItemId: item.allocationItemId,
          run: leafRunDraft(
            scenario.ticket, scenario.plan, item, agentById.get(item.assignedAgentId),
            { completionAuthority: verifiedCompletionAuthority(item) }
          )
        }))
      });
      const itemsById = new Map(scenario.plan.items.map(item => [item.allocationItemId, item]));
      const [subjectRun, siblingRun] = admitted.runs;
      const subjectItem = itemsById.get(subjectRun.allocationItemId);
      const siblingItem = itemsById.get(siblingRun.allocationItemId);

      // The sibling is genuinely, provably complete throughout.
      await terminalizeRunTo(store, siblingRun.id, 'completed');
      await store.recordRunConsequence({
        runId: siblingRun.id,
        consequence: satisfiedConsequence(await store.getRun(siblingRun.id), siblingItem)
      });

      await terminalizeRunTo(store, subjectRun.id, 'completed');
      const persistedSubject = await store.getRun(subjectRun.id);
      const authority = foreignAuthority
        ? verifiedCompletionAuthority(siblingItem)
        : persistedSubject.completionAuthoritySnapshot;
      await store.recordRunConsequence({
        runId: subjectRun.id,
        consequence: decisionConsequence(persistedSubject, {
          authority,
          checkedPath: checkedPath === null ? null : checkedPath(subjectItem, siblingItem)
        })
      });
      return { scenario, subjectRun, siblingRun, subjectItem, siblingItem };
    };

    // aggregate interrupted + Run consequence says blocked -> parent nonterminal
    const interruptedBlocked = await terminalGateCase('Aggregate interrupted blocked', {
      foreignAuthority: true,
      checkedPath: null
    });
    let gateDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: interruptedBlocked.scenario.ticket.id
    })).decision;
    assert.equal(gateDecision.aggregateStatus, 'interrupted');
    assert.equal(
      (await store.getRunConsequence(interruptedBlocked.subjectRun.id))
        .consequence.completionDecision.completionDisposition,
      'blocked',
      'the canonical projection really does see a blocked disposition'
    );
    let gated = await store.transitionTicketAfterRun({ runId: interruptedBlocked.subjectRun.id });
    assert.equal(gated.changed, false);
    assert.equal(gated.ticket.status, 'in_progress',
      'an interrupted aggregate permits no blocked parent transition');

    // aggregate interrupted + Run consequence says failed -> parent nonterminal.
    // Foreign completion authority whose postcondition the evidence does NOT
    // satisfy: the canonical projection therefore reaches `failed`, while the
    // leaf derivation refuses on the authority mismatch.
    const interruptedFailed = await terminalGateCase('Aggregate interrupted failed', {
      foreignAuthority: true,
      checkedPath: subject => ownedFolder(subject)
    });
    gateDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: interruptedFailed.scenario.ticket.id
    })).decision;
    assert.equal(gateDecision.aggregateStatus, 'interrupted');
    assert.equal(
      gateDecision.items.find(item => item.runId === interruptedFailed.subjectRun.id).reason,
      'completion_authority_mismatch'
    );
    assert.equal(
      (await store.getRunConsequence(interruptedFailed.subjectRun.id))
        .consequence.completionDecision.completionDisposition,
      'incomplete',
      'the canonical projection really does see a failing disposition'
    );
    gated = await store.transitionTicketAfterRun({ runId: interruptedFailed.subjectRun.id });
    assert.equal(gated.changed, false);
    assert.equal(gated.ticket.status, 'in_progress',
      'an interrupted aggregate permits no failed parent transition');

    // aggregate failed + canonical blocked disposition -> parent becomes blocked
    const failedBlocked = await terminalGateCase('Aggregate failed blocked', {
      foreignAuthority: false,
      checkedPath: null
    });
    gateDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: failedBlocked.scenario.ticket.id
    })).decision;
    assert.equal(gateDecision.aggregateStatus, 'failed');
    assert.equal(
      gateDecision.items.find(item => item.runId === failedBlocked.subjectRun.id).reason,
      'completion_blocked'
    );
    const blockedParent = await store.transitionTicketAfterRun({
      runId: failedBlocked.subjectRun.id
    });
    assert.equal(blockedParent.ticket.status, 'blocked',
      'a proven failed leaf set keeps the canonical blocked outcome');
    assert.equal(blockedParent.aggregateDecision.aggregateStatus, 'failed');

    // aggregate failed + canonical failed disposition -> parent becomes failed
    const failedFailed = await terminalGateCase('Aggregate failed failed', {
      foreignAuthority: false,
      checkedPath: (subject, sibling) => ownedFolder(sibling)
    });
    gateDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: failedFailed.scenario.ticket.id
    })).decision;
    assert.equal(gateDecision.aggregateStatus, 'failed');
    assert.equal(
      gateDecision.items.find(item => item.runId === failedFailed.subjectRun.id).reason,
      'completion_unsuccessful'
    );
    const failedParentGated = await store.transitionTicketAfterRun({
      runId: failedFailed.subjectRun.id
    });
    assert.equal(failedParentGated.ticket.status, 'failed',
      'a proven failed leaf set keeps the canonical failed outcome');
    assert.notEqual(blockedParent.ticket.status, failedParentGated.ticket.status,
      'the blocked/failed distinction survives the gate unchanged');

    // Repeating a proven terminal transition emits no duplicate terminal event.
    const repeatFailed = await store.transitionTicketAfterRun({
      runId: failedFailed.subjectRun.id
    });
    assert.equal(repeatFailed.changed, false);
    assert.equal(
      (await store.listTicketEvents(failedFailed.scenario.ticket.id, { limit: 200 })).events
        .filter(event => (event.runId === null || event.runId === undefined) &&
          event.payload && event.payload.status === 'failed').length,
      1,
      'repeated terminalization emits no duplicate terminal parent event'
    );

    // Concurrent sibling terminalization cannot bypass the gate.
    const concurrentGate = await terminalGateCase('Aggregate gate concurrency', {
      foreignAuthority: true,
      checkedPath: null
    });
    const concurrentOutcomes = await Promise.allSettled([
      store.transitionTicketAfterRun({ runId: concurrentGate.subjectRun.id }),
      store.transitionTicketAfterRun({ runId: concurrentGate.siblingRun.id })
    ]);
    for (const outcome of concurrentOutcomes) {
      if (outcome.status !== 'fulfilled') continue;
      assert.equal(outcome.value.changed, false);
    }
    assert.equal((await store.getTicket(concurrentGate.scenario.ticket.id)).status, 'in_progress',
      'concurrent sibling terminalization cannot bypass the aggregate gate');

    // ── Missing aggregate proof permits no terminal transition ───────────────
    //
    // A planner-admitted plan whose Runs never went through leaf admission holds
    // no binding, so no aggregate can be derived at all.
    const unbound = await admitPlan(`Missing aggregate proof ${STAMP}`);
    const unboundItem = unbound.plan.items[0];
    const unboundCreated = await store.createRunsAndStartTicket({
      ticketId: unbound.ticket.id,
      runDrafts: [leafRunDraft(
        unbound.ticket, unbound.plan, unboundItem, agentById.get(unboundItem.assignedAgentId),
        { completionAuthority: verifiedCompletionAuthority(unboundItem) }
      )]
    });
    const unboundRun = unboundCreated.runs[0];
    assert.equal(unboundRun.leafRunBinding ?? null, null,
      'this run deliberately bypassed leaf admission and holds no binding');
    await terminalizeRunTo(store, unboundRun.id, 'completed');
    await store.recordRunConsequence({
      runId: unboundRun.id,
      consequence: satisfiedConsequence(await store.getRun(unboundRun.id), unboundItem)
    });
    assert.equal(
      (await store.reconcileStructuredAllocationLeafItems({ ticketId: unbound.ticket.id }))
        .reconciled,
      false,
      'no leaf binding means no aggregate can be derived'
    );
    const unboundTransition = await store.transitionTicketAfterRun({ runId: unboundRun.id });
    assert.equal(unboundTransition.changed, false);
    assert.notEqual((await store.getTicket(unbound.ticket.id)).status, 'completed',
      'a missing aggregate proof permits no terminal transition');
    assert.equal((await store.getAllocationPlan(unbound.plan.id)).aggregateDecision ?? null, null);

    // ── A stale or hash-conflicting aggregate permits no terminal transition ──
    const tampered = await terminalGateCase('Aggregate hash conflict', {
      foreignAuthority: false,
      checkedPath: (subject) => ownedFolder(subject)
    });
    const tamperedDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: tampered.scenario.ticket.id
    })).decision;
    assert.equal(tamperedDecision.aggregateStatus, 'completed');
    // Rewrite the stored aggregate so its own hash no longer describes its items.
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{aggregateDecision,aggregateStatus}', '"failed"'::jsonb),
           revision = revision + 1
       WHERE id = $1`,
      [tampered.scenario.plan.id]
    );
    await assert.rejects(
      () => store.transitionTicketAfterRun({ runId: tampered.subjectRun.id }),
      error => /aggregatePlanDecision/.test(error.message),
      'a hash-conflicting aggregate aborts the transition instead of terminalizing'
    );
    assert.equal((await store.getTicket(tampered.scenario.ticket.id)).status, 'in_progress',
      'a conflicting aggregate leaves the parent nonterminal');

    // ── Nonterminal recovery is unaffected by the gate ───────────────────────
    //
    // An interrupted leaf returns an owned-scope ticket to `open`. That is
    // recovery, not terminalization, so it must stay reachable even though the
    // aggregate reports the leaf set unresolved.
    const recovering = await admitPlan(`Aggregate gate recovery ${STAMP}`);
    const recoveringAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: recovering.ticket.id,
      allocationPlanId: recovering.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: recovering.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          recovering.ticket, recovering.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const recoveringItems = new Map(
      recovering.plan.items.map(item => [item.allocationItemId, item]));
    const [interruptedLeaf, completedLeaf] = recoveringAdmission.runs;
    await terminalizeRunTo(store, completedLeaf.id, 'completed');
    await store.recordRunConsequence({
      runId: completedLeaf.id,
      consequence: satisfiedConsequence(
        await store.getRun(completedLeaf.id),
        recoveringItems.get(completedLeaf.allocationItemId)
      )
    });
    await terminalizeRunTo(store, interruptedLeaf.id, 'interrupted');
    const interruptedPersisted = await store.getRun(interruptedLeaf.id);
    await store.recordRunConsequence({
      runId: interruptedLeaf.id,
      consequence: decisionConsequence(interruptedPersisted, {
        authority: interruptedPersisted.completionAuthoritySnapshot,
        checkedPath: null
      })
    });
    const recoveringDecision = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: recovering.ticket.id
    })).decision;
    assert.notEqual(recoveringDecision.aggregateStatus, 'completed');
    const recovered = await store.transitionTicketAfterRun({ runId: interruptedLeaf.id });
    assert.equal(recovered.ticket.status, 'open',
      'the gate does not block nonterminal recovery to open');

    // ── One failed item prevents parent completion ───────────────────────────
    const failing = await admitPlan(`One failed item ${STAMP}`);
    const failingAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: failing.ticket.id,
      allocationPlanId: failing.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: failing.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          failing.ticket, failing.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const failingItems = new Map(failing.plan.items.map(item => [item.allocationItemId, item]));
    const okRun = failingAdmission.runs[0];
    const badRun = failingAdmission.runs[1];
    await terminalizeRunTo(store, okRun.id, 'completed');
    await store.recordRunConsequence({
      runId: okRun.id,
      consequence: satisfiedConsequence(
        await store.getRun(okRun.id),
        failingItems.get(okRun.allocationItemId)
      )
    });
    await terminalizeRunTo(store, badRun.id, 'failed');
    await store.recordRunConsequence({
      runId: badRun.id,
      consequence: completionConsequence(await store.getRun(badRun.id), 'failed')
    });
    const failedAggregate = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: failing.ticket.id,
      allocationPlanId: failing.plan.id
    })).decision;
    assert.equal(failedAggregate.aggregateStatus, 'failed',
      'one failed item prevents aggregate completion');
    assert.deepEqual(failedAggregate.failedItemIds,
      [failedAggregate.items.find(item => item.runId === badRun.id).allocationItemId]);
    assert.equal(failedAggregate.completedItemIds.length, 1,
      'the completed sibling is still reported truthfully');
    const failedParent = await store.transitionTicketAfterRun({ runId: badRun.id });
    assert.notEqual(failedParent.ticket.status, 'completed',
      'one failed item prevents parent completion');

    // ── One interrupted item remains unresolved ──────────────────────────────
    const interrupted = await admitPlan(`One interrupted item ${STAMP}`);
    const interruptedAdmission = await store.admitStructuredAllocationLeafRuns({
      ticketId: interrupted.ticket.id,
      allocationPlanId: interrupted.plan.id,
      governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
      leafDrafts: interrupted.plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(
          interrupted.ticket, interrupted.plan, item, agentById.get(item.assignedAgentId),
          { completionAuthority: verifiedCompletionAuthority(item) }
        )
      }))
    });
    const interruptedItems = new Map(
      interrupted.plan.items.map(item => [item.allocationItemId, item]));
    const doneRun = interruptedAdmission.runs[0];
    const stoppedRun = interruptedAdmission.runs[1];
    await terminalizeRunTo(store, doneRun.id, 'completed');
    await store.recordRunConsequence({
      runId: doneRun.id,
      consequence: satisfiedConsequence(
        await store.getRun(doneRun.id),
        interruptedItems.get(doneRun.allocationItemId)
      )
    });
    await terminalizeRunTo(store, stoppedRun.id, 'interrupted');
    const interruptedAggregate = (await store.reconcileStructuredAllocationLeafItems({
      ticketId: interrupted.ticket.id,
      allocationPlanId: interrupted.plan.id
    })).decision;
    assert.equal(interruptedAggregate.aggregateStatus, 'interrupted',
      'one interrupted item leaves the plan unresolved');
    const stoppedItem = interruptedAggregate.items.find(item => item.runId === stoppedRun.id);
    assert.equal(stoppedItem.itemStatus, 'interrupted');
    assert.equal(interruptedAggregate.unresolvedItemIds.includes(stoppedItem.allocationItemId),
      true);
    assert.equal(interruptedAggregate.failedItemIds.length, 0,
      'an interrupted item is unresolved, never asserted as failure');
    const interruptedParent = await store.getTicket(interrupted.ticket.id);
    assert.notEqual(interruptedParent.status, 'completed',
      'an unresolved plan never completes its parent');

    // ── Projection surfaces the durable facts ────────────────────────────────
    const projected = projectStructuredAllocationLeafExecution({
      allocationPlan: await store.getAllocationPlan(completing.plan.id),
      runs: (await store.listRunsForTicket({ ticketId: completing.ticket.id, limit: 50 })).runs,
      ticketStatus: (await store.getTicket(completing.ticket.id)).status,
      ticketExecutionMode: 'agent'
    });
    assert.equal(projected.plannerAdmittedPlan, true);
    assert.equal(projected.admissionState, 'settled',
      'a fully reconciled plan reports settled, not an unqualified availability');
    assert.equal(projected.admissionBlockedReason, null);
    assert.deepEqual(projected.schedulerVisibleRunIds, [],
      'a settled plan exposes no claimable leaf run');
    assert.equal(projected.items.length, completing.plan.items.length);
    assert.equal(projected.items.every(item =>
      item.runId !== null && item.leafBindingHash !== null &&
      item.itemDeclaredWorkHash !== null && item.ownedOutputPaths.length > 0 &&
      item.runLineage.length === 1 && item.completionDecisionHash !== null), true,
    'the projection exposes bindings, ownership, lineage and decision identity');
    assert.equal(projected.aggregateDecision.aggregateStatus, 'completed');
    assert.equal(projected.parentTicketStatus, 'completed');
    assert.deepEqual(projected.unresolvedItemIds, []);
    assert.equal(
      projectStructuredAllocationLeafExecution({ allocationPlan: null }).plannerAdmittedPlan,
      false,
      'a ticket with no planner-admitted plan projects no leaf execution'
    );
    assert.equal(
      projectStructuredAllocationLeafExecution({ allocationPlan: null }).admissionState,
      'none'
    );

    // ── Historical compatibility: v1 keeps caller-supplied item status ───────
    const v1Ticket = (await store.createTicketWithEvent({
      ticket: ticketBody(designated, `Historical v1 allocation ${STAMP}`, ownedOutputPaths),
      eventPayload: { source: ACTOR }
    })).ticket;
    const v1Plan = await store.createAllocationPlan({
      plan: {
        ticketId: v1Ticket.id,
        status: 'pending',
        mode: 'owned_paths',
        items: [{
          assignedAgentId: worker.id,
          allocationSubtask: 'Produce your allocated output inside your owned path only.',
          ownedOutputPaths: ['reports/worker/']
        }]
      }
    });
    const v1Updated = await store.updateAllocationItemStatus({
      planId: v1Plan.id,
      allocationItemId: v1Plan.items[0].allocationItemId,
      status: 'completed'
    });
    assert.equal(v1Updated.item.status, 'completed',
      'historical v1 item-status writes are unchanged');
    assert.equal((await store.getAllocationPlan(v1Plan.id)).status, 'completed');
    await assert.rejects(
      () => store.reconcileStructuredAllocationLeafItems({ ticketId: v1Ticket.id }),
      error => error.reason === 'admitted_plan_mismatch',
      'v1 plans are never reconciled through the Tranche 3 derivation'
    );

    // ── No replanning, no v1 fallback, no Tranche 4 ──────────────────────────
    const afterExecution = await store.getTicket(completing.ticket.id);
    assert.equal(
      (await store.listAllocationPlans({ ticketId: completing.ticket.id, limit: 20 })).plans.length,
      1,
      'leaf admission and reconciliation never create a second plan'
    );
    assert.equal(afterExecution.structuredAllocationPlanningAttempt.state, 'plan_admitted',
      'no second planning attempt is created');
    assert.equal(afterExecution.structuredAllocationAuthority.authorityHash,
      completing.ticket.structuredAllocationAuthority.authorityHash,
      'leaf execution does not rewrite the immutable structured authority');
    const reopened = await store.reopenTicket({ ticketId: completing.ticket.id });
    assert.equal(reopened.ticket.status, 'open');
    assert.equal(
      (await store.listAllocationPlans({ ticketId: completing.ticket.id, limit: 20 })).plans.length,
      1,
      'reopening does not replan and creates no v1 plan'
    );
    assert.equal(
      (await store.getTicket(completing.ticket.id)).structuredAllocationPlanningAttempt.state,
      'plan_admitted',
      'reopening leaves the admitted attempt terminal'
    );
    const reopenedRuns =
      (await store.listRunsForTicket({ ticketId: completing.ticket.id, limit: 50 })).runs;
    assert.equal(reopenedRuns.length, completing.plan.items.length,
      'reopening duplicates no initial item binding');
    await assert.rejects(
      () => store.admitStructuredAllocationLeafRuns({
        ticketId: completing.ticket.id,
        allocationPlanId: completing.plan.id,
        governedLeafCapture: { policySource: LEAF_WORKER_POLICY.source },
        leafDrafts: draftsFor(completing.ticket, completing.plan)
      }),
      error => error.reason === 'plan_not_pending',
      'a settled plan is never re-admitted'
    );

    for (const run of reopenedRuns) {
      assert.equal(run.parentRunId ?? null, null, 'no leaf run has a parent run');
      assert.equal(run.delegatedRunId ?? null, null, 'no leaf run delegates');
    }
    assert.deepEqual(
      (await store.listChildTickets({ parentTicketId: completing.ticket.id, limit: 20 })).tickets,
      [],
      'leaf execution spawns no child ticket and no recursive delegation'
    );

    // ── Source boundary ──────────────────────────────────────────────────────
    // Executable code only: the module explains WHY it excludes these, and that
    // explanation must not itself trip the boundary check.
    const leafSource = fs.readFileSync(
      path.join(__dirname, '..', 'runtime', 'structured-allocation-leaf-run-contract.js'),
      'utf8'
    ).replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of [
      'lowerPlannerProposalToAllocationPlanDraft',
      'createPlanningAttempt',
      'admitStructuredAllocationPlan',
      'allocationSubtask',
      'createRetryRun',
      'childTicket'
    ]) {
      assert.equal(leafSource.includes(forbidden), false,
        `the leaf-run contract must not reference ${forbidden}`);
    }

    // A peer store reconstructs every durable leaf fact deterministically.
    const peer = new PostgresRuntimeStore({
      connectionString: store.connectionString || process.env.TEST_DATABASE_URL ||
        process.env.DATABASE_URL,
      schema: store.schema
    });
    try {
      const peerPlan = await peer.getAllocationPlan(completing.plan.id);
      assert.equal(peerPlan.aggregateDecision.decisionHash,
        completedPlan.aggregateDecision.decisionHash,
        'a separate store instance reconstructs the aggregate decision deterministically');
      const peerRuns = (await peer.listRunsForTicket({
        ticketId: completing.ticket.id, limit: 50
      })).runs;
      for (const run of peerRuns) {
        normalizeLeafRunBinding(run.leafRunBinding, {
          expectedRunId: run.id,
          expectedPlanId: completing.plan.id,
          expectedPlanHash: completing.plan.planHash
        });
      }
    } finally {
      await peer.close();
    }

    console.log('structured allocation leaf-run PostgreSQL test passed');
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

// T2 lineage-closure falsification / regression.
//
// THE CLAIM UNDER TEST. Terminal aggregate finality (a persisted `completed`
// or `failed` aggregate can never legitimately face a differing current
// derivation) requires LEAF-LINEAGE CLOSURE: no NEW Run can later be admitted
// carrying a leafRunBinding to an already-admitted plan/item. Binding
// immutability on an EXISTING Run (A) and migration 039's same-attempt
// membership guard do NOT prove this; a NEW attempt admitting a Run bound to
// the OLD plan/item (B) would extend the lineage and make a previously
// terminal aggregate legitimately derivable as something else.
//
// This suite constructs the strongest source-valid falsification against
// EVERY Run-admission seam, using only repository-owned runtime admission
// (no manual database mutation):
//
//   A.  store.createRun (the low-level INSERT funnel) with a draft carrying a
//       fully valid rebuilt binding + governed envelope for the OLD plan/item.
//   A2. createRun with a binding but NO envelope (the pre-existing pairing
//       guard must refuse it — proves the falsification is not relying on a
//       broken pair).
//   B.  createRunsAndStartTicket (new attempt after reopenTicket) with the
//       smuggled draft.
//   C.  createRetryRun (the real reopen+predecessor composition) with the
//       smuggled draft.
//   D.  transitionRun bodyPatch minting a binding (+ envelope) onto a fresh
//       unbound Run of the same Ticket — including the binding-only variant.
//   E.  admitStructuredAllocationLeafRuns duplicate admission on the settled
//       plan (control: the canonical authority must re-report, never extend).
//
// The smuggled binding and envelope are rebuilt with the CANONICAL exported
// builders from the durable plan and the first admission's own captured
// authority (all fields are public durable data; the next Run identity is
// predicted by READING the runs sequence — observation, not mutation). If any
// seam accepts the smuggle, the suite prints the resulting
// settlement/cancellation divergence and FAILS.
//
// Expected result with lineage closure enforced at the INSERT funnel and the
// patch boundary: every seam refuses or cannot construct the bound Run
// before INSERT, and the canonical terminal state is intact.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
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
  buildLeafRunBinding
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
} = require('../runtime/completion-decision-contract');
const {
  buildGovernedRunAuthority,
  WORKER_ROLE
} = require('../runtime/governed-run-authority-contract');
const { buildRoleRoutingDecision } = require('../runtime/role-routing-contract');
const { buildEconomicAuthority } = require('../runtime/economic-authority-contract');
const { findPricingEntry } = require('../runtime/model-pricing-catalog');
const {
  governedAttemptState,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource,
  progressControlPolicy
} = require('./governed-structured-fixture');

const LEAF_PROGRESS_POLICY = progressControlPolicy();
const LEAF_PLANNER_POLICY = zeroPricePlannerPolicySource();
const LEAF_WORKER_POLICY = zeroPriceWorkerPolicySource();

const STAMP = `${Date.now()}-${process.pid}`;
const ACTOR = 't2-lineage-closure-postgres-test';

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [
      { kind: 'text', declaration: 'Every report records concrete findings' }
    ],
    evidenceRequirements: []
  };
}

function structuredTicketBody(group, objective, ownedOutputPaths) {
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
    status: 'open',
    blockedReason: null,
    createdBy: ACTOR,
    changedBy: ACTOR,
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function proposalFor(candidates) {
  return {
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: candidates.map(candidate => ({
      assignedAgentId: candidate.agentId,
      objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
      expectedOutputs: [{
        kind: 'text',
        declaration: `Findings report for ${candidate.ownedOutputPaths[0]}`
      }],
      successCriteria: [
        { kind: 'text', declaration: 'Report names at least one finding' }
      ],
      evidenceRequirements: []
    }))
  };
}

async function validatedPlanningAttempt(store, ticket, responseText, proposal) {
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

function leafRunDraft(ticket, plan, item, agent, completionAuthority) {
  return {
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    targetRef: null,
    workspaceRoot: '/tmp',
    mainWorkspaceRoot: '/tmp',
    executionWorkspaceType: 'main_owned_paths',
    executionPolicySnapshot: ticket.executionPolicy,
    completionAuthoritySnapshot: completionAuthority || verifiedCompletionAuthority(item),
    declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
      sharedConstraints: plan.sharedConstraints,
      completionAuthoritySnapshot: completionAuthority || verifiedCompletionAuthority(item)
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
  return (await store.transitionRun({
    runId,
    expectedRevision: running.revision,
    fromStatuses: ['running'],
    toStatus: status,
    leaseOwner: ACTOR
  })).run;
}

async function main() {
  await withHarness('t2 lineage closure', async ({ store, schema }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };

    const group = (await store.createGroup({
      value: { name: `T2 Lineage ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const planner = (await store.createConfiguredAgent({
      value: { name: `T2 Lineage Planner ${STAMP}`, provider: 'openai', model: 'fixture-planner', apiKey: '' },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const worker = (await store.createConfiguredAgent({
      value: { name: `T2 Lineage Worker ${STAMP}`, provider: 'openai', model: 'fixture-worker', apiKey: '' },
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

    // Build one fully settled v2 Ticket: plan admitted, both leaves completed
    // with valid decisions, aggregate materialized `completed`, Ticket
    // completed. Returns the durable fixtures each attack rebuilds its
    // smuggled lineage identity from.
    async function completedV2Ticket(objective) {
      const catalog = await store.getConfiguredAgentsByIds({ agentIds: [planner.id, worker.id] });
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork: declaredWork(objective),
        ticketObjective: objective,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog.find(candidate => candidate.id === planner.id),
        candidateAgents: catalog,
        ownedOutputPaths
      });
      const ticket = (await store.createTicketWithEvent({
        ticket: structuredTicketBody(designated, objective, ownedOutputPaths),
        structuredAllocationAuthorityDraft: authorityDraft,
        eventPayload: { source: ACTOR }
      })).ticket;
      const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
      const responseText = JSON.stringify(proposalFor(planning.candidates));
      const proposal = normalizePlannerProposal(JSON.parse(responseText));
      const planDraft = lowerPlannerProposalToAllocationPlanDraft({
        ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        proposal
      });
      const attempt = await validatedPlanningAttempt(store, ticket, responseText, proposal);
      const admission = await store.admitStructuredAllocationPlan({
        ticketId: ticket.id,
        attempt,
        allocationPlanDraft: planDraft,
        plannerCredentialsAvailable: true,
        eventPayload: { source: ACTOR }
      });
      assert.equal(admission.admitted, true, 'v2 plan admission fixture');
      const currentTicket = await store.getTicket(ticket.id);
      const plan = admission.plan;
      const leafAdmission = await store.admitStructuredAllocationLeafRuns({
        ticketId: ticket.id,
        allocationPlanId: plan.id,
        governedLeafCapture: {
          policySource: LEAF_WORKER_POLICY.source,
          progressControlPolicy: LEAF_PROGRESS_POLICY
        },
        leafDrafts: plan.items.map(item => ({
          allocationItemId: item.allocationItemId,
          run: leafRunDraft(currentTicket, plan, item, agentById.get(item.assignedAgentId))
        })),
        eventPayload: { source: ACTOR }
      });
      assert.equal(leafAdmission.admitted, true, 'leaf admission fixture');
      const items = new Map(plan.items.map(item => [item.allocationItemId, item]));
      for (const run of leafAdmission.runs) {
        await terminalizeRunTo(store, run.id, 'completed');
        await store.recordRunConsequence({
          runId: run.id,
          consequence: satisfiedConsequence(await store.getRun(run.id), items.get(run.allocationItemId))
        });
      }
      const reconciled = await store.reconcileStructuredAllocationLeafItems({
        ticketId: ticket.id, allocationPlanId: plan.id
      });
      assert.equal(reconciled.decision.aggregateStatus, 'completed',
        'fixture: materialized aggregate is completed');
      const settled = await store.transitionTicketAfterRun({ runId: leafAdmission.runs[0].id });
      assert.equal(settled.ticket.status, 'completed', 'fixture: Ticket settled completed');
      return {
        ticket: await store.getTicket(ticket.id),
        plan: await store.getAllocationPlan(plan.id),
        runs: leafAdmission.runs,
        items
      };
    }

    // Predict the next Run identity by READING the runs sequence (observation
    // only; no mutation). The smuggled binding must name the identity the
    // INSERT would assign, or the pairing check would refuse it for the wrong
    // reason and the falsification would prove nothing.
    async function predictNextRunId() {
      const seq = await store.pool.query(
        `SELECT last_value, is_called FROM "${schema}".runs_id_seq`
      );
      const last = Number(seq.rows[0].last_value);
      return seq.rows[0].is_called ? last + 1 : last;
    }

    // Rebuild a fully valid binding for a NEW Run identity against the OLD
    // admitted plan/item, using only durable public data and the canonical
    // exported builder.
    function smuggledBinding(fixture, item, runId) {
      return buildLeafRunBinding({
        ticketId: fixture.ticket.id,
        allocationPlanId: fixture.plan.id,
        planHash: fixture.plan.planHash,
        allocationItemId: item.allocationItemId,
        assignedAgentId: item.assignedAgentId,
        itemDeclaredWorkHash: fixture.runs
          .find(run => run.allocationItemId === item.allocationItemId).leafRunBinding
          .itemDeclaredWorkHash,
        ownedOutputPaths: item.ownedOutputPaths,
        parentDeclaredWorkHash: fixture.plan.parentDeclaredWorkSnapshot.contractHash,
        planningAttemptId: fixture.plan.planningProvenance.attemptId,
        planningAdmissionHash: fixture.plan.planningProvenance.admissionHash,
        runId,
        admittedAt: new Date().toISOString()
      });
    }

    // Rebuild a fully valid governed envelope for the NEW Run identity from
    // the same policy documents and the Ticket's already-admitted economic
    // account (read off the first admission's own captured authority).
    function smuggledEnvelope(fixture, item, runId) {
      const source = LEAF_WORKER_POLICY.source;
      const economicAccountId = fixture.runs
        .find(run => run.allocationItemId === item.allocationItemId).governedExecution
        .economicAccountId;
      const capturedAt = new Date().toISOString();
      const routingDecision = buildRoleRoutingDecision({
        policy: source.roleRoutingPolicy,
        role: WORKER_ROLE,
        ticketId: fixture.ticket.id,
        subjectKind: 'run',
        subjectId: runId,
        actingAgentId: item.assignedAgentId,
        decidedAt: capturedAt
      });
      const economicAuthority = buildEconomicAuthority({
        policy: source.economicPolicy,
        routingDecision,
        pricingCatalog: source.pricingCatalog,
        capturedAt
      });
      return buildGovernedRunAuthority({
        policySource: source,
        routingDecision,
        economicAuthority,
        pricingEntry: findPricingEntry(source.pricingCatalog, {
          provider: economicAuthority.provider,
          model: economicAuthority.dispatchTarget,
          adapterId: economicAuthority.adapterId
        }),
        progressControlPolicy: LEAF_PROGRESS_POLICY,
        economicAccountId,
        ticketId: fixture.ticket.id,
        runId,
        allocationItemId: item.allocationItemId,
        capturedAt
      });
    }

    function smuggledDraft(fixture, item, runId, withEnvelope = true) {
      return {
        ...leafRunDraft(fixture.ticket, fixture.plan, item,
          agentById.get(item.assignedAgentId)),
        leafRunBinding: smuggledBinding(fixture, item, runId),
        ...(withEnvelope
          ? { governedExecution: smuggledEnvelope(fixture, item, runId) }
          : {})
      };
    }

    // If a seam accepts a smuggle, capture and print the exact
    // settlement/cancellation divergence it creates, then fail.
    async function reportSmuggleDivergence(seam, fixture) {
      const runs = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      const current = await store.reconcileStructuredAllocationLeafItems({
        ticketId: fixture.ticket.id, allocationPlanId: fixture.plan.id
      });
      const storedBefore = fixture.plan.aggregateDecision;
      console.error(`  SMEUGGLE ACCEPTED THROUGH ${seam}:`);
      console.error(`    runs on ticket: ${runs.length} (lineage now has a later bound Run)`);
      console.error(`    persisted terminal aggregate before: ${storedBefore.aggregateStatus}`);
      console.error(`    production reconciliation refreshed it to: ${current.decision.aggregateStatus}`);
      console.error(`    (production REFRESHES a valid differing terminal aggregate; the`);
      console.error(`     shared evaluator classifies the same durable state as`);
      console.error(`     terminal_conflict and refuses — settlement/cancellation divergence.)`);
      throw new Error(`${seam}: lineage closure violated — a second Run bound to the ` +
        `old plan/item was admitted`);
    }

    // ─── ATTACK A: createRun (the low-level INSERT funnel) ────────────────
    {
      const fixture = await completedV2Ticket(`lineage closure: createRun seam ${STAMP}`);
      const item = fixture.plan.items[1];
      const predictedRunId = await predictNextRunId();
      const draft = smuggledDraft(fixture, item, predictedRunId);
      let refused = null;
      let smuggled = null;
      try {
        smuggled = await store.createRun(draft);
      } catch (error) {
        refused = error;
      }
      if (smuggled) {
        await reportSmuggleDivergence('store.createRun', fixture);
      }
      ok(refused !== null, 'createRun refuses a draft carrying a leafRunBinding');
      ok(refused && refused.code === 'RUN_LEAF_LINEAGE_NOT_CALLER_OWNED',
        `createRun refusal is the lineage-authority error (got ${refused && refused.code})`);
      const runsAfter = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfter.length, 2, 'no Run was inserted through the createRun seam');
      const planAfter = await store.getAllocationPlan(fixture.plan.id);
      equal(planAfter.aggregateDecision.aggregateStatus, 'completed',
        'the terminal aggregate is untouched');
      equal((await store.getTicket(fixture.ticket.id)).status, 'completed',
        'the Ticket remains settled');
    }

    // ─── ATTACK A2: binding without envelope (pre-existing pairing guard) ─
    {
      const fixture = await completedV2Ticket(`lineage closure: pairing guard ${STAMP}`);
      const item = fixture.plan.items[1];
      const predictedRunId = await predictNextRunId();
      const draft = smuggledDraft(fixture, item, predictedRunId, false);
      let refused = null;
      try {
        await store.createRun(draft);
      } catch (error) {
        refused = error;
      }
      ok(refused !== null,
        'a binding without a governed envelope is refused (pairing guard)');
      const runsAfter = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfter.length, 2, 'no Run was inserted through the pairing guard');
    }

    // ─── ATTACK B: createRunsAndStartTicket after reopen (new attempt) ────
    {
      const fixture = await completedV2Ticket(`lineage closure: wave admission ${STAMP}`);
      const item = fixture.plan.items[1];
      const predictedRunId = await predictNextRunId();
      await store.reopenTicket({ ticketId: fixture.ticket.id, rerunMode: 'rerun' });
      const draft = smuggledDraft(fixture, item, predictedRunId);
      let refused = null;
      let smuggled = null;
      try {
        smuggled = await store.createRunsAndStartTicket({
          ticketId: fixture.ticket.id,
          runDrafts: [draft],
          runEventPayload: () => ({ source: ACTOR })
        });
      } catch (error) {
        refused = error;
      }
      if (smuggled) {
        await reportSmuggleDivergence('store.createRunsAndStartTicket', fixture);
      }
      ok(refused !== null,
        'createRunsAndStartTicket refuses a draft carrying a leafRunBinding');
      ok(refused && refused.code === 'RUN_LEAF_LINEAGE_NOT_CALLER_OWNED',
        `wave-admission refusal is the lineage-authority error (got ${refused && refused.code})`);
      const runsAfter = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfter.length, 2, 'the new attempt admitted no bound Run');
      const planAfter = await store.getAllocationPlan(fixture.plan.id);
      equal(planAfter.aggregateDecision.aggregateStatus, 'completed',
        'the terminal aggregate is untouched by the refused wave admission');
    }

    // ─── ATTACK C: createRetryRun (real reopen+predecessor composition) ───
    {
      const fixture = await completedV2Ticket(`lineage closure: retry seam ${STAMP}`);
      const item = fixture.plan.items[1];
      const predictedRunId = await predictNextRunId();
      const draft = smuggledDraft(fixture, item, predictedRunId);
      // The predecessor must be the terminal Run of the SAME agent as the
      // smuggled draft (the retry contract requires agent continuity), which
      // is the Run bound to the same allocation item.
      const predecessor = fixture.runs
        .find(run => run.allocationItemId === item.allocationItemId);
      let refused = null;
      let smuggled = null;
      try {
        smuggled = await store.createRetryRun({
          ticketId: fixture.ticket.id,
          predecessorRunId: predecessor.id,
          runDraft: draft,
          runEventPayload: () => ({ source: ACTOR })
        });
      } catch (error) {
        refused = error;
      }
      if (smuggled) {
        await reportSmuggleDivergence('store.createRetryRun', fixture);
      }
      ok(refused !== null, 'createRetryRun refuses a draft carrying a leafRunBinding');
      ok(refused && refused.code === 'RUN_LEAF_LINEAGE_NOT_CALLER_OWNED',
        `retry refusal is the lineage-authority error (got ${refused && refused.code})`);
      // createRetryRun composes reopen + admission in ONE transaction: the
      // refusal rolls the reopen back with it.
      equal((await store.getTicket(fixture.ticket.id)).status, 'completed',
        'the refused retry rolled back its reopen — Ticket still completed');
      const runsAfter = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfter.length, 2, 'the retry admitted no bound Run');
    }

    // ─── ATTACK D: transitionRun bodyPatch mints a binding post-INSERT ────
    {
      const fixture = await completedV2Ticket(`lineage closure: patch seam ${STAMP}`);
      const item = fixture.plan.items[1];
      await store.reopenTicket({ ticketId: fixture.ticket.id, rerunMode: 'rerun' });
      // A fresh, unbound, non-terminal Run on the same Ticket.
      const plain = await store.createRunsAndStartTicket({
        ticketId: fixture.ticket.id,
        runDrafts: [{
          ticketId: fixture.ticket.id,
          agentId: item.assignedAgentId,
          status: 'pending',
          executionMode: 'agent'
        }],
        runEventPayload: () => ({ source: ACTOR })
      });
      const target = plain.runs[0];
      const binding = smuggledBinding(fixture, item, target.id);
      const envelope = smuggledEnvelope(fixture, item, target.id);
      let refused = null;
      try {
        await store.transitionRun({
          runId: target.id,
          expectedRevision: target.revision,
          fromStatuses: ['pending'],
          toStatus: 'failed',
          patch: { leafRunBinding: binding, governedExecution: envelope },
          eventType: 'run.failed',
          eventPayload: { source: ACTOR }
        });
      } catch (error) {
        refused = error;
      }
      ok(refused !== null, 'transitionRun refuses to mint a leafRunBinding by patch');
      ok(refused && refused.code === 'RUN_LEAF_LINEAGE_IMMUTABLE',
        `patch refusal is the lineage-immutability error (got ${refused && refused.code})`);
      const after = await store.getRun(target.id);
      equal(after.leafRunBinding, undefined,
        'the patched Run carries no binding (transaction rolled back)');
      equal(after.status, 'pending', 'the patched Run is untouched');

      // Binding-only patch: refused by the pairing guard even without an
      // envelope (pre-existing fail-closed behavior on read).
      let pairingRefused = null;
      try {
        await store.transitionRun({
          runId: target.id,
          expectedRevision: after.revision,
          fromStatuses: ['pending'],
          toStatus: 'failed',
          patch: { leafRunBinding: binding },
          eventType: 'run.failed',
          eventPayload: { source: ACTOR }
        });
      } catch (error) {
        pairingRefused = error;
      }
      ok(pairingRefused !== null,
        'a binding-only patch is also refused (pairing guard)');
      const after2 = await store.getRun(target.id);
      equal(after2.status, 'pending', 'the binding-only patch also rolled back');
    }

    // ─── ATTACK E (control): duplicate canonical leaf admission ───────────
    // Two independent mechanical layers refuse extension through the
    // canonical authority itself: (1) a plan whose status has left `pending`
    // refuses leaf admission outright; (2) while pending, a complete committed
    // leaf set re-reports itself instead of extending (covered by
    // scripts/structured-allocation-leaf-run-postgres-test.js). Here the plan
    // is reconciled terminal, so layer (1) must fire.
    {
      const fixture = await completedV2Ticket(`lineage closure: canonical control ${STAMP}`);
      let refused = null;
      try {
        await store.admitStructuredAllocationLeafRuns({
          ticketId: fixture.ticket.id,
          allocationPlanId: fixture.plan.id,
          governedLeafCapture: {
            policySource: LEAF_WORKER_POLICY.source,
            progressControlPolicy: LEAF_PROGRESS_POLICY
          },
          leafDrafts: fixture.plan.items.map(item => ({
            allocationItemId: item.allocationItemId,
            run: leafRunDraft(fixture.ticket, fixture.plan, item,
              agentById.get(item.assignedAgentId))
          })),
          eventPayload: { source: ACTOR }
        });
      } catch (error) {
        refused = error;
      }
      ok(refused !== null,
        'the canonical authority refuses leaf admission on the settled plan');
      ok(refused && refused.code === 'STRUCTURED_ALLOCATION_LEAF_ADMISSION_REFUSED' &&
        refused.reason === 'plan_not_pending',
        `canonical refusal is plan_not_pending (got ${refused && refused.reason})`);
      const runsAfter = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfter.length, 2, 'duplicate canonical admission created no Run');
      const reconciliation = await store.reconcileStructuredAllocationLeafItems({
        ticketId: fixture.ticket.id, allocationPlanId: fixture.plan.id
      });
      equal(reconciliation.changed, false,
        'reconciliation over the intact lineage is idempotent');
      equal(reconciliation.decision.aggregateStatus, 'completed',
        'the current derivation still matches the terminal aggregate');
    }

    // ─── ATTACK F: forge the lineage-admission AUTHORITY itself ──────────
    //
    // A boolean option is caller-forgeable: store.withTransaction hands a
    // transaction client to ANY repository caller, so "leafLineageAdmission:
    // true && client !== null" grants lineage minting to whoever chooses the
    // option value — current call-site convention, not admission authority.
    // These attacks use ONLY repository-owned transaction composition (no
    // manual database mutation) and the same fully valid rebuilt binding +
    // governed envelope proven capable of extending the old settled lineage.
    {
      const fixture = await completedV2Ticket(`lineage closure: forged authority ${STAMP}`);
      const item = fixture.plan.items[1];

      // F1: createRun with the forged boolean, inside a real client.
      {
        const predictedRunId = await predictNextRunId();
        const draft = smuggledDraft(fixture, item, predictedRunId);
        let refused = null;
        let smuggled = null;
        try {
          smuggled = await store.withTransaction(client =>
            store.createRun(draft, { client, leafLineageAdmission: true }));
        } catch (error) {
          refused = error;
        }
        if (smuggled) {
          await reportSmuggleDivergence(
            'createRun with caller-forged leafLineageAdmission:true', fixture);
        }
        ok(refused !== null,
          'createRun refuses a caller-forged leafLineageAdmission:true');
        ok(refused && refused.code === 'RUN_LEAF_LINEAGE_NOT_CALLER_OWNED',
          `forged-boolean refusal is the lineage-authority error (got ${refused && refused.code})`);
      }

      // F2: full composition — reopen + wave admission — with the forged
      // boolean. A refusal must roll the reopen back with it.
      {
        const predictedRunId = await predictNextRunId();
        const draft = smuggledDraft(fixture, item, predictedRunId);
        let refused = null;
        let smuggled = null;
        try {
          smuggled = await store.withTransaction(async client => {
            await store.reopenTicket(
              { ticketId: fixture.ticket.id, rerunMode: 'rerun' }, { client });
            return store.createRunsAndStartTicket({
              ticketId: fixture.ticket.id,
              runDrafts: [draft],
              runEventPayload: () => ({ source: ACTOR })
            }, { client, leafLineageAdmission: true });
          });
        } catch (error) {
          refused = error;
        }
        if (smuggled) {
          await reportSmuggleDivergence(
            'createRunsAndStartTicket with caller-forged leafLineageAdmission:true', fixture);
        }
        ok(refused !== null,
          'createRunsAndStartTicket refuses a caller-forged leafLineageAdmission:true');
        equal((await store.getTicket(fixture.ticket.id)).status, 'completed',
          'the forged wave admission rolled back its reopen — Ticket still completed');
      }

      // F3: forged capability values under the capability option name.
      // NONE may confer lineage-minting authority — not a boolean, not a
      // string, not an object, and not a caller-created Symbol carrying the
      // SAME DESCRIPTION as the private one (Symbol identity, not its
      // description, is the authority).
      for (const [label, value] of [
        ['boolean true', true],
        ['arbitrary string', 'canonical-structured-leaf-admission'],
        ['arbitrary object', { leafLineageAdmission: true }],
        ['caller-created Symbol with the private description',
          Symbol('postgresRuntimeStore.leafLineageMint')]
      ]) {
        const predictedRunId = await predictNextRunId();
        const draft = smuggledDraft(fixture, item, predictedRunId);
        let refused = null;
        let smuggled = null;
        try {
          smuggled = await store.withTransaction(client =>
            store.createRun(draft, { client, leafLineageMint: value }));
        } catch (error) {
          refused = error;
        }
        if (smuggled) {
          await reportSmuggleDivergence(
            `createRun with forged leafLineageMint (${label})`, fixture);
        }
        ok(refused !== null, `createRun refuses a forged capability (${label})`);
        ok(refused && refused.code === 'RUN_LEAF_LINEAGE_AUTHORITY_INVALID',
          `forged-capability refusal for ${label} (got ${refused && refused.code})`);
      }

      // The forged-capability authority is also refused on the wave seam.
      {
        const predictedRunId = await predictNextRunId();
        const draft = smuggledDraft(fixture, item, predictedRunId);
        let refused = null;
        try {
          await store.withTransaction(async client => {
            await store.reopenTicket(
              { ticketId: fixture.ticket.id, rerunMode: 'rerun' }, { client });
            return store.createRunsAndStartTicket({
              ticketId: fixture.ticket.id,
              runDrafts: [draft],
              runEventPayload: () => ({ source: ACTOR })
            }, { client, leafLineageMint: true });
          });
        } catch (error) {
          refused = error;
        }
        ok(refused !== null,
          'createRunsAndStartTicket refuses a forged capability value');
        equal((await store.getTicket(fixture.ticket.id)).status, 'completed',
          'the forged-capability wave admission rolled back its reopen');
      }

      // No F attack changed any durable state.
      const runsAfterF = (await store.listRunsForTicket({
        ticketId: fixture.ticket.id, limit: 50
      })).runs;
      equal(runsAfterF.length, 2, 'no forged-authority attack inserted a Run');
      const planAfterF = await store.getAllocationPlan(fixture.plan.id);
      equal(planAfterF.aggregateDecision.aggregateStatus, 'completed',
        'the terminal aggregate is untouched by every forged-authority attack');
      equal((await store.getCurrentTicketAttempt(fixture.ticket.id)).disposition, 'completed',
        'the settled attempt is untouched by every forged-authority attack');
    }

    function equal(actual, expected, message) {
      assert.deepEqual(actual, expected, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    }

    console.log(`  ${assertions} assertions passed`);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

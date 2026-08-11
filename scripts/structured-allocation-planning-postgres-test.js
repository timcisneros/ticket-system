#!/usr/bin/env node
'use strict';

// Tranche 2B PostgreSQL suite: durable planning attempts, atomic Allocation
// Plan v2 admission, concurrency and idempotency, lifecycle containment,
// restart reconstruction, and proof that a successfully admitted plan creates
// zero worker runs and no scheduler-visible execution unit.
//
// No provider is contacted anywhere in this suite. The end-to-end path uses a
// planner whose credentials cannot resolve, so invocation readiness refuses
// deterministically on every machine; the admission path is exercised directly
// against the store with a synthetic validated attempt, which is exactly the
// transaction production runs.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  advancePlanningAttempt,
  assertAdmissionBinding,
  buildPlannerRequestMessages,
  computeAdmissionHash,
  buildPlannerRequestContext,
  createPlanningAttempt,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  plannerRequestHash,
  recoverInterruptedPlanningAttempt
} = require('../runtime/structured-allocation-planning-contract');
const { withHarness } = require('./postgres-test-harness');
const {
  governedAttemptState,
  plannerPolicySource
} = require('./governed-structured-fixture');

// Tranche 4 cutover: an attempt becomes request-capable only with complete
// governed authority, so these fixtures capture it the way production does.
const PLANNER_POLICY = plannerPolicySource();

const STAMP = `${Date.now()}-${process.pid}`;
const ACTOR = 'structured-allocation-planning-postgres-test';

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [{ kind: 'text', declaration: 'Every report records concrete findings' }],
    evidenceRequirements: []
  };
}

function ticketBody(group, objective, ownedOutputPaths, status = 'blocked') {
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
    blockedReason: status === 'blocked' ? 'Tranche 2B fixture; no worker run is admitted.' : null,
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
      successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
      evidenceRequirements: []
    }))
  };
}

// Drive an attempt to proposal_validated exactly the way production does, so
// the admission transaction under test receives realistic durable evidence.
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
  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt,
    expectedAttemptStateHash: null,
    eventType: 'ticket.structured_planning_started'
  })).attempt;

  // Capture governed authority before the attempt becomes request-capable,
  // exactly as the production planner does.
  const { governedExecution: governedBlock } = await governedAttemptState(store, {
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    plannerAgentId: planning.planner.agentId,
    policy: PLANNER_POLICY
  });

  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt: advancePlanningAttempt(attempt, {
      state: 'request_started',
      governedExecution: governedBlock,
      requestHash,
      requestMetadata: {
        contextVersion: context.version,
        contextHash: context.contextHash,
        messageCount: messages.length,
        requestBytes: messages.reduce((total, m) => total + m.content.length, 0),
        timeoutMs: 120_000,
        maxResponseBytes: 262_144
      },
      requestStartedAt: new Date().toISOString()
    }),
    expectedAttemptStateHash: attempt.attemptStateHash,
    eventType: 'ticket.structured_planning_requested'
  })).attempt;

  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt: advancePlanningAttempt(attempt, {
      state: 'response_received',
      responseStatus: 'received',
      responseText,
      responseBytes: responseText.length,
      responseTruncated: false,
      responseHash
    }),
    expectedAttemptStateHash: attempt.attemptStateHash,
    eventType: 'ticket.structured_planning_responded'
  })).attempt;

  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt: advancePlanningAttempt(attempt, {
      state: 'proposal_validated',
      parseStatus: 'ok',
      validationStatus: 'ok',
      proposalHash: proposal.proposalHash
    }),
    expectedAttemptStateHash: attempt.attemptStateHash,
    eventType: 'ticket.structured_planning_validated'
  })).attempt;

  return attempt;
}

async function main() {
  await withHarness('structured allocation planning PostgreSQL', async ({
    store, schema, databaseUrl, workspaceRoot, startServer
  }) => {
    const group = (await store.createGroup({
      value: { name: `Planning Admission ${STAMP}`, permissions: [], canReceiveTickets: true },
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
    // Read current catalog rows on every admission. This suite deliberately
    // mutates an agent later to prove catalog drift cannot rewrite an admitted
    // plan, and ticket admission legitimately refuses a stale revision.
    const currentAgents = async () => store.getConfiguredAgentsByIds({
      agentIds: [planner.id, worker.id]
    });

    const createStructuredTicket = async (objective, status = 'blocked') => {
      const catalog = await currentAgents();
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork: declaredWork(objective),
        ticketObjective: objective,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog.find(agent => agent.id === planner.id),
        candidateAgents: catalog,
        ownedOutputPaths
      });
      assert.equal(authorityDraft.structuredAllocationEligibility.eligible, true);
      return (await store.createTicketWithEvent({
        ticket: ticketBody(designated, objective, ownedOutputPaths, status),
        structuredAllocationAuthorityDraft: authorityDraft,
        eventPayload: { source: ACTOR }
      })).ticket;
    };

    // ── Successful atomic admission ──────────────────────────────────────────
    const ticket = await createStructuredTicket(`Admit a structured plan ${STAMP}`);
    const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
    const responseText = JSON.stringify(proposalFor(planning.candidates));
    const proposal = normalizePlannerProposal(JSON.parse(responseText));
    const planDraft = lowerPlannerProposalToAllocationPlanDraft({
      ticketId: ticket.id,
      authority: ticket.structuredAllocationAuthority,
      proposal
    });
    const attempt = await validatedAttempt(store, ticket, responseText, proposal);
    assert.equal(attempt.state, 'proposal_validated');

    const admission = await store.admitStructuredAllocationPlan({
      ticketId: ticket.id,
      attempt,
      allocationPlanDraft: planDraft,
      plannerCredentialsAvailable: true,
      eventPayload: { source: ACTOR }
    });
    assert.equal(admission.admitted, true);

    // ── Success state ────────────────────────────────────────────────────────
    const plans = (await store.listAllocationPlans({ ticketId: ticket.id, limit: 20 })).plans;
    assert.equal(plans.length, 1, 'exactly one v2 allocation plan exists');
    const plan = plans[0];
    assert.equal(plan.version, 2);
    assert.equal(plan.status, 'pending');
    assert.equal(plan.items.length, planning.candidates.length,
      'every captured candidate receives exactly one item');
    assert.deepEqual(
      plan.items.map(item => item.ownedOutputPaths),
      planning.candidates.map(candidate => candidate.ownedOutputPaths),
      'ownership comes from the captured snapshot, never the proposal'
    );
    assert.equal(plan.parentDeclaredWorkSnapshot.contractHash,
      ticket.structuredAllocationAuthority.parentDeclaredWorkSnapshot.contractHash);
    assert.equal(plan.planningProvenance.planHash, plan.planHash);
    assert.equal(plan.planningProvenance.attemptId, attempt.attemptId);
    // Three independently validated values survive the round trip.
    assertAdmissionBinding({
      planHash: plan.planHash,
      provenanceHash: plan.planningProvenance.provenanceHash,
      admissionHash: plan.planningProvenance.admissionHash
    });
    assert.equal(plan.planningProvenance.admissionHash, computeAdmissionHash({
      planHash: plan.planHash,
      provenanceHash: plan.planningProvenance.provenanceHash
    }));
    // The complete response is durable: bytes and hash both agree with the
    // stored text, so response_received onward reparses without a new request.
    assert.equal(attempt.responseTruncated, false);
    assert.equal(attempt.responseBytes, Buffer.byteLength(attempt.responseText, 'utf8'));
    assert.equal(
      crypto.createHash('sha256').update(attempt.responseText, 'utf8').digest('hex'),
      attempt.responseHash
    );
    assert.equal(
      normalizePlannerProposal(JSON.parse(attempt.responseText)).proposalHash,
      attempt.proposalHash,
      'the durable response deterministically reproduces the admitted proposal hash'
    );
    assert.equal(plan.planningProvenance.provider, 'openai');
    assert.equal(plan.planningProvenance.requestHash, attempt.requestHash);
    assert.equal(plan.planningProvenance.responseHash, attempt.responseHash);
    assert.equal(plan.planningProvenance.proposalHash, attempt.proposalHash);

    const admittedTicket = await store.getTicket(ticket.id);
    assert.equal(admittedTicket.structuredAllocationPlanningAttempt.state, 'plan_admitted');
    assert.equal(admittedTicket.structuredAllocationPlanningAttempt.admittedPlanId, plan.id);
    assert.equal(admittedTicket.structuredAllocationPlanningAttempt.admittedPlanHash, plan.planHash);
    assert.equal(admittedTicket.structuredAllocationAuthority.authorityHash,
      ticket.structuredAllocationAuthority.authorityHash,
      'admission does not rewrite the immutable authority');

    // ── Zero worker runs, no scheduler visibility, no completion ─────────────
    assert.deepEqual((await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs, [],
      'a successfully admitted v2 plan creates zero worker runs');
    const pending = await store.listPendingRuns({ limit: 50 });
    assert.equal((pending.runs || []).some(run => run.ticketId === ticket.id), false,
      'no scheduler-visible execution unit exists');
    assert.notEqual(admittedTicket.status, 'completed', 'no completion claim exists');

    const admissionEvents = (await store.listTicketEvents(ticket.id, { limit: 50 })).events;
    const admittedEvent = admissionEvents.find(e => e.type === 'ticket.allocation_plan_admitted');
    assert(admittedEvent, 'admission appends its event');
    assert.equal(admittedEvent.payload.allocationPlanId, plan.id);
    assert.equal(admittedEvent.payload.planHash, plan.planHash);
    assert.equal(admittedEvent.payload.workerRunsCreated, 0);
    assert.equal(admittedEvent.payload.leafExecutionCapabilityAvailable, true,
      'the admission event reports the product capability, not a per-ticket claim');
    assert.equal(admittedEvent.payload.workerRunsCreated, 0,
      'plan admission itself still creates zero worker runs');
    for (const stage of ['started', 'requested', 'responded', 'validated']) {
      assert.equal(
        admissionEvents.some(e => e.type === `ticket.structured_planning_${stage}`),
        true,
        `the ${stage} stage is durably evidenced`
      );
    }

    // ── Idempotency ──────────────────────────────────────────────────────────
    const repeat = await store.admitStructuredAllocationPlan({
      ticketId: ticket.id,
      attempt,
      allocationPlanDraft: planDraft,
      plannerCredentialsAvailable: true
    });
    assert.equal(repeat.admitted, false, 'an admitted attempt stays idempotently admitted');
    assert.equal(repeat.plan.id, plan.id);
    assert.equal((await store.listAllocationPlans({ ticketId: ticket.id, limit: 20 })).plans.length, 1,
      'a repeated admission never creates a second plan');
    assert.deepEqual((await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs, []);

    // A stale caller holding the pre-admission attempt cannot re-admit either.
    await assert.rejects(
      store.writeStructuredAllocationPlanningAttempt({
        ticketId: ticket.id,
        attempt: advancePlanningAttempt(attempt, {
          state: 'failed',
          failureStage: 'admission',
          failureReason: 'plan_admission_conflict',
          completedAt: new Date().toISOString()
        }),
        expectedAttemptStateHash: attempt.attemptStateHash
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_CONFLICT'
    );

    // ── Restart reconstruction ───────────────────────────────────────────────
    const peer = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      assert.deepEqual(await peer.migrate(), []);
      const peerPlan = await peer.getAllocationPlanForTicket(ticket.id);
      assert.equal(peerPlan.planHash, plan.planHash);
      assert.equal(peerPlan.planningProvenance.provenanceHash, plan.planningProvenance.provenanceHash);
      const peerTicket = await peer.getTicket(ticket.id);
      assert.deepEqual(peerTicket.structuredAllocationPlanningAttempt,
        admittedTicket.structuredAllocationPlanningAttempt);
    } finally {
      await peer.close();
    }

    // Catalog change after admission rewrites nothing.
    await store.updateConfiguredAgent({
      agentId: worker.id,
      expectedRevision: worker.revision,
      value: { ...worker, model: 'drifted-after-admission' },
      groupIds: [group.id],
      changedBy: ACTOR
    });
    const afterDrift = await store.getAllocationPlanForTicket(ticket.id);
    assert.equal(afterDrift.planHash, plan.planHash);
    assert.equal(afterDrift.planningProvenance.provenanceHash, plan.planningProvenance.provenanceHash);
    assert.deepEqual((await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs, []);

    // Tranche 3: for a planner-admitted v2 plan the item status is derived from
    // persisted execution facts inside the store, so a caller-supplied write is
    // refused outright rather than preserved. The provenance-preservation
    // invariant now belongs to the reconciliation write path and is proven in
    // scripts/structured-allocation-leaf-run-postgres-test.js.
    await assert.rejects(
      () => store.updateAllocationItemStatus({
        planId: plan.id,
        allocationItemId: plan.items[0].allocationItemId,
        status: 'running'
      }),
      error => error.code === 'ALLOCATION_ITEM_STATUS_NOT_CALLER_OWNED',
      'a caller cannot supply the item status of a planner-admitted plan'
    );
    const afterRefusedWrite = await store.getAllocationPlan(plan.id);
    assert.equal(afterRefusedWrite.revision, afterDrift.revision,
      'the refused write does not bump the plan revision');
    assert.equal(afterRefusedWrite.planningProvenance.provenanceHash,
      plan.planningProvenance.provenanceHash);
    assert.equal(afterRefusedWrite.planningProvenance.admissionHash,
      plan.planningProvenance.admissionHash,
      'the refused write preserves the admission binding');
    assert.deepEqual(afterRefusedWrite.items.map(item => item.status),
      plan.items.map(() => 'pending'),
      'every item status is unchanged by the refused write');

    // ── Rollback: a rejected plan leaves no partial state ────────────────────
    const rollbackTicket = await createStructuredTicket(`Rollback on invalid plan ${STAMP}`);
    const rollbackPlanning = rollbackTicket.structuredAllocationAuthority.planningAuthoritySnapshot;
    const rollbackResponse = JSON.stringify(proposalFor(rollbackPlanning.candidates));
    const rollbackProposal = normalizePlannerProposal(JSON.parse(rollbackResponse));
    const rollbackAttempt = await validatedAttempt(
      store, rollbackTicket, rollbackResponse, rollbackProposal
    );
    const rollbackDraft = lowerPlannerProposalToAllocationPlanDraft({
      ticketId: rollbackTicket.id,
      authority: rollbackTicket.structuredAllocationAuthority,
      proposal: rollbackProposal
    });
    await assert.rejects(
      store.admitStructuredAllocationPlan({
        ticketId: rollbackTicket.id,
        attempt: rollbackAttempt,
        // An item whose declared work is empty cannot become v2 authority.
        allocationPlanDraft: {
          ...rollbackDraft,
          items: rollbackDraft.items.map(item => ({ ...item, expectedOutputs: [] }))
        },
        plannerCredentialsAvailable: true
      })
    );
    assert.deepEqual(
      (await store.listAllocationPlans({ ticketId: rollbackTicket.id, limit: 20 })).plans, [],
      'a rejected admission leaves no partial v2 plan'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: rollbackTicket.id, limit: 20 })).runs, [],
      'a rejected admission creates no worker runs'
    );
    assert.equal(
      (await store.getTicket(rollbackTicket.id)).structuredAllocationPlanningAttempt.state,
      'proposal_validated',
      'a rolled-back admission does not advance the attempt'
    );

    // ── Route drift between response and admission ───────────────────────────
    const driftTicket = await createStructuredTicket(`Route drift before admission ${STAMP}`);
    const driftPlanning = driftTicket.structuredAllocationAuthority.planningAuthoritySnapshot;
    const driftResponse = JSON.stringify(proposalFor(driftPlanning.candidates));
    const driftProposal = normalizePlannerProposal(JSON.parse(driftResponse));
    const driftAttempt = await validatedAttempt(store, driftTicket, driftResponse, driftProposal);
    const driftDraft = lowerPlannerProposalToAllocationPlanDraft({
      ticketId: driftTicket.id,
      authority: driftTicket.structuredAllocationAuthority,
      proposal: driftProposal
    });
    await assert.rejects(
      store.admitStructuredAllocationPlan({
        ticketId: driftTicket.id,
        attempt: driftAttempt,
        allocationPlanDraft: driftDraft,
        plannerCredentialsAvailable: false
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_PLAN_ADMISSION_CONFLICT' &&
        /planner_credentials_unavailable/.test(error.message),
      'credentials lost between response and admission must refuse'
    );
    assert.deepEqual(
      (await store.listAllocationPlans({ ticketId: driftTicket.id, limit: 20 })).plans, []);

    // Ticket assignment drift between response and admission.
    await store.reassignTicket({
      ticketId: driftTicket.id,
      expectedRevision: (await store.getTicket(driftTicket.id)).revision,
      fromStatuses: ['blocked'],
      assignmentTargetType: 'agent',
      assignmentTargetId: worker.id,
      assignmentMode: 'individual',
      changedBy: ACTOR,
      eventType: 'ticket.updated'
    });
    await assert.rejects(
      store.admitStructuredAllocationPlan({
        ticketId: driftTicket.id,
        attempt: driftAttempt,
        allocationPlanDraft: driftDraft,
        plannerCredentialsAvailable: true
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_PLAN_ADMISSION_CONFLICT' &&
        /assignment_changed_since_capture/.test(error.message)
    );
    assert.deepEqual(
      (await store.listAllocationPlans({ ticketId: driftTicket.id, limit: 20 })).plans, [],
      'stale authority cannot be made usable by drift'
    );
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: driftTicket.id, limit: 20 })).runs, []);

    // ── Concurrency: only one attempt may start ──────────────────────────────
    const raceTicket = await createStructuredTicket(`Concurrent planning ${STAMP}`);
    const firstAttempt = createPlanningAttempt({
      attemptId: crypto.randomUUID(),
      ticketId: raceTicket.id,
      authority: raceTicket.structuredAllocationAuthority,
      createdAt: new Date().toISOString()
    });
    const secondAttempt = createPlanningAttempt({
      attemptId: crypto.randomUUID(),
      ticketId: raceTicket.id,
      authority: raceTicket.structuredAllocationAuthority,
      createdAt: new Date().toISOString()
    });
    const raced = await Promise.allSettled([
      store.writeStructuredAllocationPlanningAttempt({
        ticketId: raceTicket.id, attempt: firstAttempt, expectedAttemptStateHash: null
      }),
      store.writeStructuredAllocationPlanningAttempt({
        ticketId: raceTicket.id, attempt: secondAttempt, expectedAttemptStateHash: null
      })
    ]);
    assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1,
      'exactly one concurrent planning attempt is admitted');
    assert.equal(
      raced.find(result => result.status === 'rejected').reason.code,
      'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_CONFLICT'
    );

    // ── Interrupted request is never repeated ────────────────────────────────
    const interruptedTicket = await createStructuredTicket(`Interrupted request ${STAMP}`);
    const interruptedContext = buildPlannerRequestContext(
      interruptedTicket.structuredAllocationAuthority, { ticketId: interruptedTicket.id }
    );
    const interruptedMessages = buildPlannerRequestMessages(interruptedContext);
    let started = createPlanningAttempt({
      attemptId: crypto.randomUUID(),
      ticketId: interruptedTicket.id,
      authority: interruptedTicket.structuredAllocationAuthority,
      createdAt: new Date().toISOString()
    });
    started = (await store.writeStructuredAllocationPlanningAttempt({
      ticketId: interruptedTicket.id, attempt: started, expectedAttemptStateHash: null
    })).attempt;
    const { governedExecution: interruptedGoverned } = await governedAttemptState(store, {
      ticketId: interruptedTicket.id,
      attemptId: started.attemptId,
      plannerAgentId: interruptedTicket.structuredAllocationAuthority
        .planningAuthoritySnapshot.planner.agentId,
      policy: PLANNER_POLICY
    });
    started = (await store.writeStructuredAllocationPlanningAttempt({
      ticketId: interruptedTicket.id,
      attempt: advancePlanningAttempt(started, {
        state: 'request_started',
        governedExecution: interruptedGoverned,
        requestHash: plannerRequestHash({
          provider: 'openai', model: 'gpt-planner-test', messages: interruptedMessages
        }),
        requestMetadata: {
          contextVersion: interruptedContext.version,
          contextHash: interruptedContext.contextHash,
          messageCount: interruptedMessages.length,
          requestBytes: 512,
          timeoutMs: 120_000,
          maxResponseBytes: 262_144
        },
        requestStartedAt: new Date().toISOString()
      }),
      expectedAttemptStateHash: started.attemptStateHash
    })).attempt;

    const recovered = recoverInterruptedPlanningAttempt(started, {
      completedAt: new Date().toISOString(),
      detail: 'process restart with no durable response'
    });
    await store.writeStructuredAllocationPlanningAttempt({
      ticketId: interruptedTicket.id,
      attempt: recovered,
      expectedAttemptStateHash: started.attemptStateHash
    });
    const recoveredTicket = await store.getTicket(interruptedTicket.id);
    assert.equal(recoveredTicket.structuredAllocationPlanningAttempt.state, 'interrupted');
    assert.equal(recoveredTicket.structuredAllocationPlanningAttempt.responseStatus, 'outcome_unknown');
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: interruptedTicket.id, limit: 20 })).runs, [],
      'recovery creates no worker runs'
    );
    assert.deepEqual(
      (await store.listAllocationPlans({ ticketId: interruptedTicket.id, limit: 20 })).plans, []);

    // ── Malformed and hash-conflicting stored state fails closed ─────────────
    await store.pool.query(
      `UPDATE ${store.table('tickets')}
       SET body = jsonb_set(body, '{structuredAllocationPlanningAttempt,state}', '"plan_admitted"', true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [interruptedTicket.id]
    );
    await assert.rejects(store.getTicket(interruptedTicket.id),
      error => error.name === 'StructuredAllocationPlanningError');
    await store.pool.query(
      `UPDATE ${store.table('tickets')}
       SET body = body - 'structuredAllocationPlanningAttempt',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [interruptedTicket.id]
    );

    // A generic ticket patch may never rewrite planning evidence.
    await assert.rejects(
      store.transitionTicketState({
        ticketId: ticket.id,
        fromStatuses: ['blocked'],
        toStatus: 'blocked',
        patch: { structuredAllocationPlanningAttempt: null },
        eventType: 'ticket.updated'
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_IMMUTABLE'
    );

    // Tampered provenance fails closed on read.
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance,model}', '"tampered-model"', true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id]
    );
    await assert.rejects(store.getAllocationPlan(plan.id),
      error => error.name === 'StructuredAllocationPlanningError');
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance,model}', '"gpt-planner-test"', true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id]
    );
    assert.equal((await store.getAllocationPlan(plan.id)).planHash, plan.planHash);

    // Tampering only the admission binding also fails closed.
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance,admissionHash}', $2::jsonb, true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id, JSON.stringify('0'.repeat(64))]
    );
    await assert.rejects(store.getAllocationPlan(plan.id),
      error => /does not bind its plan and provenance/.test(error.message));
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance,admissionHash}', $2::jsonb, true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id, JSON.stringify(plan.planningProvenance.admissionHash)]
    );

    // A planner-admitted plan cannot project with provenance removed.
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance}', $2::jsonb, true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id, JSON.stringify({
        ...plan.planningProvenance,
        admissionHash: undefined
      })]
    );
    await assert.rejects(store.getAllocationPlan(plan.id),
      error => /missing field/.test(error.message),
      'partial provenance fails closed');
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{planningProvenance}', $2::jsonb, true),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [plan.id, JSON.stringify(plan.planningProvenance)]
    );
    assert.equal((await store.getAllocationPlan(plan.id)).planHash, plan.planHash);

    // ── Historical compatibility ─────────────────────────────────────────────
    const historical = await store.createTicket({
      status: 'blocked', objective: `Historical ticket ${STAMP}`
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(historical, 'structuredAllocationAuthority'), false);
    assert.equal(
      Object.prototype.hasOwnProperty.call(historical, 'structuredAllocationPlanningAttempt'), false,
      'no planning state is synthesized for historical tickets');
    const v1Plan = await store.createAllocationPlan({
      plan: {
        ticketId: historical.id,
        mode: 'owned_paths',
        status: 'pending',
        items: [{
          assignedAgentId: worker.id,
          allocationSubtask: 'Historical v1 subtask',
          ownedOutputPaths: ['reports/legacy/']
        }]
      }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(v1Plan, 'version'), false,
      'historical v1 plans are unchanged');
    assert.equal(Object.prototype.hasOwnProperty.call(v1Plan, 'planningProvenance'), false,
      'no planner provenance is synthesized historically');

    // ── End-to-end containment through the live server ───────────────────────
    const server = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      // Deterministic refusal: an openai planner with no resolvable credential
      // fails invocation readiness before any provider request is issued.
      OPENAI_API_KEY: ''
    } });
    const cookie = await server.login();
    fs.mkdirSync(path.join(workspaceRoot, 'reports', 'planner'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'reports', 'worker'), { recursive: true });

    const liveObjective = `Create structured review reports ${STAMP}`;
    const beforeTicketCount = (await store.listTickets({ limit: 500 })).tickets.length;
    const beforePlanCount = (await store.listAllocationPlans({ limit: 500 })).plans.length;
    const beforeRunCount = (await store.listRuns({ limit: 500 })).runs.length;
    const created = await server.request('POST', '/tickets', {
      cookie,
      form: {
        objective: liveObjective,
        acceptanceCriteria: 'Structured planning owns this decomposition.',
        declaredWork: JSON.stringify(declaredWork(liveObjective)),
        assignmentTargetType: 'group',
        assignmentTargetId: String(designated.id),
        assignmentMode: 'allocated',
        capabilityType: 'directAction',
        executionTargetKind: 'workspace',
        ownedOutputPaths: JSON.stringify(ownedOutputPaths)
      }
    });
    assert.equal(created.statusCode, 400, created.body.slice(0, 1000));
    assert.match(created.body, /first-class structured planner\/leaf product path is retired/i,
      'the normal product boundary no longer admits structured parent authority');
    const liveTicket = (await store.listTickets({ limit: 500 })).tickets
      .find(candidate => candidate.objective === liveObjective);
    assert.equal(liveTicket, undefined,
      'the refusal occurs before Ticket creation rather than creating a new blocked topology');
    assert.equal((await store.listTickets({ limit: 500 })).tickets.length, beforeTicketCount,
      'the refusal creates no Ticket');
    assert.equal((await store.listAllocationPlans({ limit: 500 })).plans.length, beforePlanCount,
      'the refusal creates no v2 plan and does not fall back to v1');
    assert.equal((await store.listRuns({ limit: 500 })).runs.length, beforeRunCount,
      'the refusal creates no planner or leaf Run');

    // Projections tell the truth about the admitted plan. Tranche 3 landed, so
    // leaf-run admission is reported as available — but this suite drives the
    // store directly and never calls it, so the plan below still holds zero
    // worker runs, which the assertions above and below prove independently.
    const api = await server.request('GET', `/api/tickets/${ticket.id}/runtime`, { cookie });
    assert.equal(api.statusCode, 200);
    const apiBody = JSON.parse(api.body);
    assert.equal(apiBody.structuredAllocationPlanning.attempt.state, 'plan_admitted');
    assert.equal(apiBody.structuredAllocationPlanning.attempt.admittedPlanId, plan.id);
    // The planning projection reports the PRODUCT capability only.
    assert.equal(apiBody.structuredAllocationPlanning.leafExecutionCapabilityAvailable, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        apiBody.structuredAllocationPlanning, 'leafExecutionAvailable'),
      false,
      'the overloaded per-ticket availability boolean is gone'
    );
    // Per-ticket state is a separate, closed projection. No leaf admission has
    // run for this plan, so it reports not_admitted with no binding, no decision
    // and nothing claimable — never an unqualified "available".
    const leafProjection = apiBody.structuredAllocationLeafExecution;
    assert.equal(leafProjection.plannerAdmittedPlan, true);
    assert.equal(leafProjection.admissionState, 'not_admitted');
    assert.deepEqual(leafProjection.schedulerVisibleRunIds, []);
    assert.equal(
      leafProjection.items.every(item =>
        item.runId === null && item.leafBindingHash === null),
      true,
      'an unadmitted plan projects no item-to-Run binding'
    );
    assert.equal(leafProjection.aggregateDecision, null);
    assert.deepEqual(leafProjection.completedItemIds, []);
    assert.equal(apiBody.structuredAllocationPlanning.planningProvenance.planHash, plan.planHash);
    assert.equal(JSON.stringify(apiBody).includes('apiKey'), false,
      'projections never expose credentials');

    const page = await server.request('GET', `/tickets/${ticket.id}`, { cookie });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Structured Allocation Planning/);
    assert.match(page.body, /plan_admitted/);
    assert.match(page.body, new RegExp(plan.planHash));
    assert.match(page.body, /Leaf execution capability/i);
    assert.match(page.body, /Admission state/i);
    assert.match(page.body, /not_admitted/);
    assert.match(page.body, /Plan admission itself creates zero worker runs/i);

    const timeline = await server.request('GET', `/api/tickets/${ticket.id}/timeline`, { cookie });
    assert.equal(timeline.statusCode, 200);
    const timelineBody = JSON.parse(timeline.body);
    const entries = timelineBody.entries || timelineBody.timeline || [];
    assert.equal(entries.some(entry => entry.type === 'ticket.allocation_plan_admitted'), true,
      'admission is visible on the ticket timeline');

    const cookieToken = /sessionId=([^;]+)/.exec(cookie)?.[1];
    assert(cookieToken);
    const cookieFile = path.join(os.tmpdir(), `oquery-planning-${STAMP}.cookie`);
    try {
      fs.writeFileSync(cookieFile, cookieToken);
      const cli = execFileSync(process.execPath, [
        path.join(__dirname, 'oquery.js'), 'ticket', String(ticket.id), '--url', server.baseUrl
      ], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, OPERC_COOKIE_PATH: cookieFile },
        encoding: 'utf8'
      });
      assert.match(cli, /planning attempt/);
      assert.match(cli, /plan_admitted/);
      assert.match(cli, new RegExp(plan.planHash));
      assert.match(cli, /leaf execution capability.*available/);
      assert.match(cli, /leaf admission state.*not_admitted/);
      assert.match(cli, /scheduler-visible leaf runs.*none/);
      assert.match(cli, /aggregate decision.*not yet reconciled/);
      assert.match(cli, /work unit.*run none/);
    } finally {
      fs.rmSync(cookieFile, { force: true });
    }

    console.log('structured allocation planning PostgreSQL tests passed');
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';

// T2 Tranche 2 cancellation-authority falsification.
//
// This suite owns the durable Ticket cancellation substrate only. The legacy
// Ticket status column remains unchanged because the five-state status cutover
// is intentionally deferred. Every test uses an isolated PostgreSQL schema.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  projectTicketLifecycle
} = require('../runtime/ticket-lifecycle-contract');
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
  buildLeafDeclaredWorkSnapshot
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
} = require('../runtime/completion-decision-contract');
const {
  governedAttemptState,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource,
  progressControlPolicy
} = require('./governed-structured-fixture');

const ACTOR = 't2-cancellation-authority-postgres-test';
const PLANNER_POLICY = zeroPricePlannerPolicySource();
const WORKER_POLICY = zeroPriceWorkerPolicySource();
const PROGRESS_POLICY = progressControlPolicy();

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One report per assigned folder' }],
    successCriteria: [{ kind: 'text', declaration: 'The report records a finding' }],
    evidenceRequirements: []
  };
}

function ticketBody(group, objective, ownedOutputPaths) {
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
      maxWorkspaceOperations: null, allowParallelRuns: false,
      allowChildTickets: false, workspaceScope: 'owned_paths'
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
    sharedConstraints: [{ kind: 'text', declaration: 'Stay in your own folder' }],
    items: candidates.map(candidate => ({
      assignedAgentId: candidate.agentId,
      objective: `Review ${candidate.ownedOutputPaths[0]} and record a finding`,
      expectedOutputs: [{
        kind: 'text',
        declaration: `Findings report for ${candidate.ownedOutputPaths[0]}`
      }],
      successCriteria: [{ kind: 'text', declaration: 'Report names a finding' }],
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
  const { governedExecution } = await governedAttemptState(store, {
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    plannerAgentId: planning.planner.agentId,
    policy: PLANNER_POLICY
  });
  await write({
    state: 'request_started',
    governedExecution,
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

function completionAuthority(item) {
  return buildCompletionAuthoritySnapshot({
    objective: `Review ${item.ownedOutputPaths[0]} and record a finding`,
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

function leafDraft(ticket, plan, item, agent) {
  const authority = completionAuthority(item);
  return {
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    targetRef: null,
    workspaceRoot: '/tmp',
    mainWorkspaceRoot: '/tmp',
    executionWorkspaceType: 'main_owned_paths',
    executionPolicySnapshot: ticket.executionPolicy,
    completionAuthoritySnapshot: authority,
    declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
      sharedConstraints: plan.sharedConstraints,
      completionAuthoritySnapshot: authority
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

async function terminalizeRun(store, run, status = 'completed', patch = {}) {
  const owner = `${ACTOR}-${run.id}`;
  const claim = await store.claimPendingRun({
    leaseOwner: owner,
    leaseDurationMs: 60_000,
    eligibleRunIds: [run.id]
  });
  const started = await store.startClaimedRun({
    runId: run.id,
    leaseOwner: owner,
    leaseDurationMs: 60_000
  });
  const transitioned = await store.transitionRun({
    runId: run.id,
    expectedRevision: started.run.revision,
    fromStatuses: ['running'],
    toStatus: status,
    leaseOwner: owner,
    patch,
    eventType: `run.${status}`,
    eventPayload: { source: ACTOR }
  });
  return transitioned.run;
}

function satisfiedConsequence(run, item) {
  const path = item.ownedOutputPaths[0].replace(/\/$/, '');
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
          checkedPaths: [{ type: 'folder', path }]
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

async function main() {
  await withHarness('t2 cancellation authority', async ({ store, schema }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const equal = (actual, expected, message) => {
      assert.deepEqual(actual, expected, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const refuses = async (operation, code, message) => {
      let error = null;
      try { await operation(); } catch (caught) { error = caught; }
      ok(error !== null, message);
      equal(error && error.code, code, `${message} code`);
      return error;
    };
    const observeWriter = async operation => {
      try {
        return { kind: 'fulfilled', value: await operation() };
      } catch (error) {
        return { kind: 'rejected', error };
      }
    };

    const agent = (await store.createConfiguredAgent({
      value: { name: `T2 Cancel Agent ${Date.now()}`, provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const peer = (await store.createConfiguredAgent({
      value: { name: `T2 Cancel Peer ${Date.now()}`, provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const makeTicket = objective => store.createTicket({
      objective,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent'
    });
    const draft = (ticketId, agentId = agent.id) => ({
      ticketId,
      agentId,
      status: 'pending',
      executionMode: 'agent'
    });
    const admit = (ticket, drafts = [draft(ticket.id)]) =>
      store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: drafts,
        runEventPayload: () => ({ source: ACTOR })
      });

    // A: cancellation wins before completion is inevitable.
    const winningTicket = await makeTicket('cancellation wins before completion');
    const winningAttempt = await admit(winningTicket, [
      draft(winningTicket.id, agent.id),
      draft(winningTicket.id, peer.id)
    ]);
    await terminalizeRun(store, winningAttempt.runs[0]);
    const winning = await store.cancelTicket({
      ticketId: winningTicket.id,
      requestedBy: 'operator-a',
      authoritySource: 'operator',
      reason: 'operator abandoned the work'
    });
    equal(winning.changed, true, 'cancellation commits before completion is inevitable');
    equal(winning.lifecycle.state, 'canceled', 'cancellation projects canonical lifecycle to canceled');
    equal(winning.ticket.status, 'in_progress',
      'legacy Ticket status remains unchanged before the five-state cutover');
    equal((await store.getTicket(winningTicket.id)).cancellationAuthority.requestedBy,
      'operator-a', 'cancellation authority is durable and attributable');
    const postCancelSettlement = await store.transitionTicketAfterRun({
      runId: winningAttempt.runs[0].id
    });
    equal(postCancelSettlement.changed, false,
      'settlement cannot replace a committed cancellation authority');

    // F: exact semantic repeat is idempotent; rewrite is refused.
    const repeated = await store.cancelTicket({
      ticketId: winningTicket.id,
      requestedBy: 'operator-a',
      authoritySource: 'operator',
      reason: 'operator abandoned the work'
    });
    equal(repeated.idempotent, true, 'identical cancellation is idempotent');
    equal(repeated.event, null, 'identical cancellation appends no second event');
    await refuses(() => store.cancelTicket({
      ticketId: winningTicket.id,
      requestedBy: 'operator-b',
      authoritySource: 'operator',
      reason: 'different reason'
    }), 'TICKET_CANCELLATION_AUTHORITY_CONFLICT',
    'a different cancellation authority is refused');
    await refuses(() => store.createRunsAndStartTicket({
      ticketId: winningTicket.id,
      runDrafts: [draft(winningTicket.id)]
    }), 'TICKET_CANCELLATION_ALREADY_COMMITTED',
    'attempt admission after cancellation is refused');
    await refuses(() => store.reopenTicket({
      ticketId: winningTicket.id,
      rerunMode: 'rerun'
    }), 'TICKET_CANCELLATION_ALREADY_COMMITTED',
    'reopen after cancellation is refused');

    // G: PostgreSQL validates every authority shape before runtime reads, and
    // the immutable trigger refuses replacement after a valid first write.
    const shapeTicket = await makeTicket('direct SQL cancellation shape checks');
    const validShape = {
      ...winning.cancellationAuthority,
      ticketId: shapeTicket.id,
      committedAt: '2026-08-20T00:00:00.000Z'
    };
    const requiredFields = [
      'version', 'ticketId', 'authoritySource', 'requestedBy', 'reason', 'committedAt'
    ];
    const malformedShapes = [
      ['empty object', {}],
      ...requiredFields.map(field => {
        const value = { ...validShape };
        delete value[field];
        return [`missing ${field}`, value];
      }),
      ...requiredFields.map(field => [
        `null ${field}`,
        { ...validShape, [field]: null }
      ]),
      ['blank authoritySource', { ...validShape, authoritySource: '   ' }],
      ['blank requestedBy', { ...validShape, requestedBy: '   ' }],
      ['blank reason', { ...validShape, reason: '   ' }],
      ['wrong Ticket binding', { ...validShape, ticketId: shapeTicket.id + 1 }],
      ['unsupported version', { ...validShape, version: 2 }],
      ['wrong version JSON type', { ...validShape, version: '1' }],
      ['wrong Ticket JSON type', { ...validShape, ticketId: String(shapeTicket.id) }],
      ['wrong authoritySource JSON type', { ...validShape, authoritySource: 7 }],
      ['wrong requestedBy JSON type', { ...validShape, requestedBy: {} }],
      ['wrong reason JSON type', { ...validShape, reason: [] }],
      ['wrong committedAt JSON type', { ...validShape, committedAt: 7 }],
      ['impossible committedAt timestamp', {
        ...validShape,
        committedAt: '2026-99-99T99:99:99.000Z'
      }],
      ['unsupported extra field', { ...validShape, extra: true }]
    ];
    for (const [label, malformed] of malformedShapes) {
      const result = await store.pool.query(
        `UPDATE "${schema}".tickets
         SET cancellation_authority = $2::jsonb,
             revision = revision + 1
         WHERE id = $1`,
        [shapeTicket.id, JSON.stringify(malformed)]
      ).catch(error => error);
      ok(result && result.code === '23514',
        `PostgreSQL rejects malformed authority shape: ${label}`);
    }
    const validWrite = await store.pool.query(
      `UPDATE "${schema}".tickets
       SET cancellation_authority = $2::jsonb,
           revision = revision + 1
       WHERE id = $1`,
      [shapeTicket.id, JSON.stringify(validShape)]
    );
    equal(validWrite.rowCount, 1, 'PostgreSQL accepts one exact valid authority shape');
    equal((await store.getTicket(shapeTicket.id)).cancellationAuthority.ticketId,
      shapeTicket.id, 'valid direct SQL authority is readable through the runtime normalizer');
    const rewrite = await store.pool.query(
      `UPDATE "${schema}".tickets
       SET cancellation_authority = jsonb_set(cancellation_authority, '{reason}', '"rewritten"')
       WHERE id = $1`,
      [shapeTicket.id]
    ).catch(error => error);
    ok(rewrite && rewrite.code === 'P0001',
      'PostgreSQL mechanically refuses cancellation-authority replacement');

    // B: durable completion wins before cancellation evaluates.
    const completedTicket = await makeTicket('completion wins first');
    const completedAttempt = await admit(completedTicket);
    const completedRun = await terminalizeRun(store, completedAttempt.runs[0]);
    const settled = await store.transitionTicketAfterRun({ runId: completedRun.id });
    equal(settled.ticket.status, 'completed', 'durable completion settles the Ticket');
    await refuses(() => store.cancelTicket({
      ticketId: completedTicket.id,
      requestedBy: 'operator-a',
      reason: 'too late'
    }), 'TICKET_CANCELLATION_COMPLETED',
    'cancellation of an already completed Ticket is refused');

    // C1: completion is already durable before the writers race. Cancellation
    // must refuse; settlement must retain COMPLETED regardless of scheduling.
    const preExistingCompletionTicket = await makeTicket('completion exists before writer race');
    const preExistingAttempt = await admit(preExistingCompletionTicket, [
      draft(preExistingCompletionTicket.id, agent.id),
      draft(preExistingCompletionTicket.id, peer.id)
    ]);
    await Promise.all([
      terminalizeRun(store, preExistingAttempt.runs[0]),
      terminalizeRun(store, preExistingAttempt.runs[1])
    ]);
    const preExistingResults = await Promise.all([
      observeWriter(() => store.cancelTicket({
        ticketId: preExistingCompletionTicket.id,
        requestedBy: 'pre-existing-operator',
        reason: 'completion was already durable'
      })),
      observeWriter(() => store.transitionTicketAfterRun({
        runId: preExistingAttempt.runs[0].id
      }))
    ]);
    const preExistingCancel = preExistingResults[0];
    const preExistingSettlement = preExistingResults[1];
    equal(preExistingCancel.kind, 'rejected',
      'pre-existing completion race cancellation refuses');
    ok([
      'TICKET_CANCELLATION_COMPLETION_INEVITABLE',
      'TICKET_CANCELLATION_COMPLETED'
    ].includes(preExistingCancel.error.code),
    `pre-existing completion refusal has exact cause (${preExistingCancel.error.code})`);
    equal(preExistingSettlement.kind, 'fulfilled',
      'pre-existing completion race settlement fulfills');
    equal(preExistingSettlement.value.ticket.status, 'completed',
      'pre-existing completion race retains COMPLETED');
    equal((await store.getTicket(preExistingCompletionTicket.id)).cancellationAuthority, null,
      'pre-existing completion race writes no cancellation authority');
    equal((await store.getCurrentTicketAttempt(preExistingCompletionTicket.id)).disposition,
      'completed', 'pre-existing completion race settles the attempt completed');

    // C2: forced cancellation-first ordering. Completion is not inevitable at
    // the cancellation serialization point; later settlement cannot replace it.
    const forcedCancelTicket = await makeTicket('forced cancellation first');
    const forcedCancelAttempt = await admit(forcedCancelTicket, [
      draft(forcedCancelTicket.id, agent.id),
      draft(forcedCancelTicket.id, peer.id)
    ]);
    await terminalizeRun(store, forcedCancelAttempt.runs[0]);
    const forcedCancel = await store.cancelTicket({
      ticketId: forcedCancelTicket.id,
      requestedBy: 'forced-cancel-operator',
      reason: 'cancellation reached the authority first'
    });
    const forcedCancelSettlement = await store.transitionTicketAfterRun({
      runId: forcedCancelAttempt.runs[0].id
    });
    equal(forcedCancel.changed, true, 'forced cancellation-first ordering commits cancellation');
    equal(forcedCancelSettlement.changed, false,
      'forced cancellation-first ordering blocks later settlement');
    equal((await store.getCurrentTicketAttempt(forcedCancelTicket.id)).disposition,
      null, 'forced cancellation-first ordering leaves the attempt unsettled');

    // C3: forced completion-first ordering. The same source-correct refusal is
    // observed without relying on a broad either-terminal assertion.
    const forcedCompletionTicket = await makeTicket('forced completion first');
    const forcedCompletionAttempt = await admit(forcedCompletionTicket, [
      draft(forcedCompletionTicket.id, agent.id),
      draft(forcedCompletionTicket.id, peer.id)
    ]);
    await Promise.all([
      terminalizeRun(store, forcedCompletionAttempt.runs[0]),
      terminalizeRun(store, forcedCompletionAttempt.runs[1])
    ]);
    const forcedCompletion = await store.transitionTicketAfterRun({
      runId: forcedCompletionAttempt.runs[0].id
    });
    const forcedCompletionCancel = await observeWriter(() => store.cancelTicket({
      ticketId: forcedCompletionTicket.id,
      requestedBy: 'forced-completion-operator',
      reason: 'completion reached the authority first'
    }));
    equal(forcedCompletion.changed, true, 'forced completion-first ordering settles COMPLETED');
    equal(forcedCompletionCancel.kind, 'rejected',
      'forced completion-first ordering refuses cancellation');
    equal(forcedCompletionCancel.error.code, 'TICKET_CANCELLATION_COMPLETED',
      'forced completion-first refusal names completed Ticket cause');
    equal((await store.getTicket(forcedCompletionTicket.id)).cancellationAuthority, null,
      'forced completion-first ordering writes no cancellation authority');

    // C4: actual not-yet-inevitable writer race. Only the two paired orderings
    // above are accepted: cancellation first, or final completion first.
    const raceTicket = await makeTicket('actual cancellation versus completion race');
    const raceAttempt = await admit(raceTicket, [
      draft(raceTicket.id, agent.id),
      draft(raceTicket.id, peer.id)
    ]);
    await terminalizeRun(store, raceAttempt.runs[0]);
    const finalRaceOwner = `${ACTOR}-final-race-${raceAttempt.runs[1].id}`;
    const finalRaceClaim = await store.claimPendingRun({
      leaseOwner: finalRaceOwner,
      leaseDurationMs: 60_000,
      eligibleRunIds: [raceAttempt.runs[1].id]
    });
    ok(finalRaceClaim && finalRaceClaim.run,
      'actual race final member is claimed before the writer race');
    const finalRaceStarted = await store.startClaimedRun({
      runId: raceAttempt.runs[1].id,
      leaseOwner: finalRaceOwner,
      leaseDurationMs: 60_000
    });
    ok(finalRaceStarted && finalRaceStarted.run,
      'actual race final member is running before the writer race');
    const completeFinalMember = async () => {
      await store.transitionRun({
        runId: raceAttempt.runs[1].id,
        expectedRevision: finalRaceStarted.run.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: finalRaceOwner,
        eventType: 'run.completed',
        eventPayload: { source: ACTOR }
      });
      return store.transitionTicketAfterRun({ runId: raceAttempt.runs[1].id });
    };
    const raceResults = await Promise.all([
      observeWriter(() => store.cancelTicket({
        ticketId: raceTicket.id,
        requestedBy: 'race-operator',
        reason: 'race cancellation'
      })),
      observeWriter(completeFinalMember)
    ]);
    equal(raceResults[0].kind === 'fulfilled' || raceResults[0].kind === 'rejected', true,
      'actual race cancellation writer completed boundedly');
    equal(raceResults[1].kind, 'fulfilled',
      `actual race completion writer fulfilled (${raceResults[1].error &&
        raceResults[1].error.code}: ${raceResults[1].error && raceResults[1].error.message})`);
    const raceTicketAfter = await store.getTicket(raceTicket.id);
    const raceAuthority = raceTicketAfter.cancellationAuthority;
    if (raceResults[0].kind === 'fulfilled') {
      equal(raceResults[0].value.changed, true,
        'actual race cancellation-first fulfillment commits authority');
      equal(raceResults[1].value.changed, false,
        'actual race cancellation-first settlement is blocked');
      ok(raceAuthority !== null, 'actual race cancellation-first has cancellation authority');
      equal((await store.getCurrentTicketAttempt(raceTicket.id)).disposition, null,
        'actual race cancellation-first attempt remains unsettled');
    } else {
      ok([
        'TICKET_CANCELLATION_COMPLETION_INEVITABLE',
        'TICKET_CANCELLATION_COMPLETED'
      ].includes(raceResults[0].error.code),
      `actual race completion-first cancellation refusal has exact cause (${raceResults[0].error.code})`);
      equal(raceResults[1].value.changed, true,
        'actual race completion-first settlement commits completion');
      equal(raceAuthority, null, 'actual race completion-first has no cancellation authority');
      equal((await store.getCurrentTicketAttempt(raceTicket.id)).disposition,
        'completed', 'actual race completion-first attempt is completed');
    }

    // H: Run cancellation-shaped evidence is not Ticket cancellation.
    const runOnlyTicket = await makeTicket('run cancellation is not Ticket cancellation');
    const runOnlyAttempt = await admit(runOnlyTicket);
    const runOnly = await terminalizeRun(
      store,
      runOnlyAttempt.runs[0],
      'failed',
      { executionDisposition: 'cancelled' }
    );
    equal(runOnly.executionDisposition, 'cancelled',
      'Run cancellation-shaped evidence is stored below Ticket authority');
    const runOnlyTicketAfter = await store.getTicket(runOnlyTicket.id);
    ok(runOnlyTicketAfter.cancellationAuthority === null,
      'Run execution cancellation creates no Ticket cancellation authority');
    ok(projectTicketLifecycle({
      cancellationAuthority: runOnlyTicketAfter.cancellationAuthority,
      currentAttempt: await store.getCurrentTicketAttempt(runOnlyTicket.id)
    }).state !== 'canceled',
    'Run cancellation-shaped evidence does not project Ticket to canceled');

    // D: v2 stale nonterminal materialization with completed current evidence.
    const group = (await store.createGroup({
      value: { name: `T2 Cancel Group ${Date.now()}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const planner = (await store.createConfiguredAgent({
      value: { name: `T2 Cancel Planner ${Date.now()}`, provider: 'openai', model: 'fixture-planner', apiKey: '' },
      groupIds: [group.id], changedBy: ACTOR
    })).agent;
    const designatedGroup = (await store.updateGroup({
      groupId: group.id,
      expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id },
      changedBy: ACTOR
    })).group;
    const ownedOutputPaths = {
      [planner.id]: 'cancel/planner/',
      [peer.id]: 'cancel/peer/'
    };
    const groupedPeer = (await store.updateConfiguredAgent({
      agentId: peer.id,
      expectedRevision: peer.revision,
      value: peer,
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;
    const v2Body = ticketBody(group, 'v2 cancellation authority', ownedOutputPaths);
    const authorityDraft = buildStructuredAllocationAuthorityDraft({
      declaredWork: declaredWork(v2Body.objective),
      ticketObjective: v2Body.objective,
      assignmentTargetType: 'group',
      assignmentMode: 'allocated',
      assignmentGroup: designatedGroup,
      plannerAgent: planner,
      candidateAgents: [planner, groupedPeer],
      ownedOutputPaths
    });
    const v2Ticket = (await store.createTicketWithEvent({
      ticket: v2Body,
      structuredAllocationAuthorityDraft: authorityDraft,
      eventPayload: { source: ACTOR }
    })).ticket;
    const proposal = normalizePlannerProposal(JSON.parse(JSON.stringify(proposalFor(
      v2Ticket.structuredAllocationAuthority.planningAuthoritySnapshot.candidates
    ))));
    const planning = await validatedPlanningAttempt(
      store,
      v2Ticket,
      JSON.stringify(proposal),
      proposal
    );
    const planAdmission = await store.admitStructuredAllocationPlan({
      ticketId: v2Ticket.id,
      attempt: planning,
      allocationPlanDraft: lowerPlannerProposalToAllocationPlanDraft({
        ticketId: v2Ticket.id,
        authority: v2Ticket.structuredAllocationAuthority,
        proposal
      }),
      plannerCredentialsAvailable: true,
      eventPayload: { source: ACTOR }
    });
    const v2Plan = planAdmission.plan;
    const currentV2Ticket = await store.getTicket(v2Ticket.id);
    const v2Admission = await store.admitStructuredAllocationLeafRuns({
      ticketId: v2Ticket.id,
      allocationPlanId: v2Plan.id,
      governedLeafCapture: {
        policySource: WORKER_POLICY.source,
        progressControlPolicy: PROGRESS_POLICY
      },
      leafDrafts: v2Plan.items.map(item => {
        const run = leafDraft(
          currentV2Ticket,
          v2Plan,
          item,
          item.assignedAgentId === planner.id ? planner : groupedPeer
        );
        return {
          allocationItemId: item.allocationItemId,
          run
        };
      }),
      eventPayload: { source: ACTOR }
    });
    ok(v2Admission.admitted === true, 'canonical v2 leaf admission succeeds for cancellation test');
    const v2Items = new Map(v2Plan.items.map(item => [item.allocationItemId, item]));
    const firstV2Run = v2Admission.runs[0];
    const lastV2Run = v2Admission.runs[1];
    await terminalizeRun(store, firstV2Run);
    await store.recordRunConsequence({
      runId: firstV2Run.id,
      consequence: satisfiedConsequence(
        await store.getRun(firstV2Run.id),
        v2Items.get(firstV2Run.allocationItemId)
      )
    });
    const staleMaterialization = await store.reconcileStructuredAllocationLeafItems({
      ticketId: v2Ticket.id,
      allocationPlanId: v2Plan.id
    });
    equal(staleMaterialization.decision.aggregateStatus, 'pending',
      'v2 cancellation fixture materializes a nonterminal aggregate');
    await terminalizeRun(store, lastV2Run);
    await store.recordRunConsequence({
      runId: lastV2Run.id,
      consequence: satisfiedConsequence(
        await store.getRun(lastV2Run.id),
        v2Items.get(lastV2Run.allocationItemId)
      )
    });
    await refuses(() => store.cancelTicket({
      ticketId: v2Ticket.id,
      requestedBy: 'v2-operator',
      reason: 'v2 stale aggregate cancellation attempt'
    }), 'TICKET_CANCELLATION_COMPLETION_INEVITABLE',
    'stale nonterminal v2 materialization cannot beat current completion');
    equal((await store.getTicket(v2Ticket.id)).cancellationAuthority, null,
      'stale v2 completion refusal writes no cancellation authority');

    // E: a malformed/misbound stored v2 authority fails closed before cancel.
    const malformedPlanHash = 'f'.repeat(64);
    await store.pool.query(
      `UPDATE "${schema}".allocation_plans
       SET body = jsonb_set(body, '{aggregateDecision,planHash}', $2::jsonb),
           revision = revision + 1
       WHERE id = $1`,
      [v2Plan.id, JSON.stringify(malformedPlanHash)]
    );
    let malformedError = null;
    try {
      await store.cancelTicket({
        ticketId: v2Ticket.id,
        requestedBy: 'v2-operator',
        reason: 'malformed authority cancellation attempt'
      });
    } catch (error) {
      malformedError = error;
    }
    ok(malformedError !== null, 'malformed v2 authority refuses cancellation fail-closed');
    equal((await store.getTicket(v2Ticket.id)).cancellationAuthority, null,
      'malformed v2 refusal writes no cancellation authority');
    console.log(`  ${assertions} assertions passed`);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

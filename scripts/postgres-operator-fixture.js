'use strict';
// Shared PostgreSQL seeding for the operator-surface test suites
// (operator-visibility-test.js, oquery-parity-test.js). Replaces their legacy
// JSON DATA_DIR seed (seed-demo-data.js), which the PostgreSQL-only server can
// no longer import: every fixture is created through the same store authority
// the runtime uses, so what the tests observe is what production writes —
// real lifecycle transitions, evidence-linked events, and triage records.
//
// The demo semantics (objectives, triage texts, evidence shapes) mirror
// scripts/seed-demo-data.js so the operator surfaces keep asserting the same
// product loop: ticket → run → verification → triage → inbox → resolution.

const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const LEASE_OWNER = 'operator-fixture-worker';

function executionPolicy() {
  return {
    mode: 'assisted',
    requireVerification: 'when_declared',
    autoRetry: false,
    maxAttempts: null,
    maxRuntimeMs: null,
    maxModelRequests: null,
    maxWorkspaceOperations: null,
    allowWorkspaceWrites: true,
    allowParallelRuns: false,
    allowChildTickets: false,
    workspaceScope: 'shared'
  };
}

function baseTicket(agent, overrides) {
  const now = new Date().toISOString();
  return {
    acceptanceCriteria: null,
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    ownedOutputPaths: null,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: executionPolicy(),
    workTypeId: null,
    workTypeSnapshot: null,
    workContextId: null,
    workContextSnapshot: null,
    status: 'open',
    createdBy: 'admin',
    changedBy: 'admin',
    changedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

// Drive a run through its real lifecycle: pending → claimed → running →
// terminalized with replay snapshot, verification event, evaluation, and
// consequence recorded in the single terminalization authority operation.
async function seedTerminalRun(store, {
  ticket, agent, status, error = null, ownedOutputPaths = null,
  replaySnapshot, evaluation, consequence, verificationEvent = null
}) {
  const created = await store.createRun({
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    ...(ownedOutputPaths ? { ownedOutputPaths } : {}),
    status: 'pending'
  });
  const claim = await store.claimPendingRun({
    leaseOwner: LEASE_OWNER,
    leaseDurationMs: 60_000,
    eligibleRunIds: [created.id]
  });
  const started = await store.transitionRun({
    runId: created.id,
    expectedRevision: claim.run.revision,
    fromStatuses: ['pending'],
    toStatus: 'running',
    leaseOwner: LEASE_OWNER,
    eventType: 'run.started'
  });
  const terminal = await store.terminalizeRun({
    runId: created.id,
    expectedRevision: started.run.revision,
    fromStatuses: ['running'],
    status,
    leaseOwner: LEASE_OWNER,
    patch: error ? { error } : {},
    replaySnapshot: { runId: created.id, ...replaySnapshot },
    evaluation,
    consequence,
    executionEvent: { type: 'run.execution_completed', payload: { status } },
    beforeReplayEvents: verificationEvent ? [verificationEvent] : [],
    replayEvent: { type: 'run.snapshot_finalized', payload: {} },
    terminalEvent: { type: 'run.terminalized', payload: { status } }
  });
  return terminal.run;
}

async function seedOperatorFixture(store) {
  const agent = (await store.createConfiguredAgent({
    value: { name: 'Demo Agent', provider: 'ollama', model: 'demo-model', apiKey: '' },
    groupIds: [],
    changedBy: 'admin'
  })).agent;

  const context = (await store.createWorkContext({
    value: {
      name: 'Demo Context',
      purpose: 'Operator visibility fixture',
      status: 'active',
      allowedTargetIds: [],
      allowedCapabilities: [],
      allowedProcessTemplateIds: []
    },
    changedBy: 'admin'
  })).workContext;

  // Work Type catalog rows. The store exposes read-only catalog access
  // (listWorkTypes/getWorkType); rows are provisioned operationally — the
  // PostgreSQL cutover test seeds them the same way.
  await store.pool.query(
    `INSERT INTO ${store.table('work_types')} (id, status, body) VALUES
       ($1, 'active', $2::jsonb), ($3, 'inactive', $4::jsonb)`,
    [
      'meeting-brief',
      { name: 'Meeting Brief', description: 'Summarize a meeting.', allowedTargetKinds: ['workspace'] },
      'site-audit',
      { name: 'Site Audit', description: 'Read-only page inspection.', allowedTargetKinds: ['browser'] }
    ]
  );

  // ── Completed + verified run (the "run 101" of the demo loop) ──
  const verifiedTicket = (await store.createTicketWithEvent({
    ticket: baseTicket(agent, {
      objective: 'Generate Q3 compliance summary (completed + verified)',
      status: 'completed'
    }),
    eventPayload: { source: 'operator-fixture' }
  })).ticket;
  const verifiedRun = await seedTerminalRun(store, {
    ticket: verifiedTicket,
    agent,
    status: 'completed',
    ownedOutputPaths: ['reports/q3'],
    replaySnapshot: {
      terminalStatus: 'completed',
      parsedModelPlans: [
        {
          message: 'Creating the summary file from the three inputs.',
          actions: [{ operation: 'writeFile', args: { path: 'reports/q3/summary.md' } }],
          complete: true,
          step: 1
        }
      ],
      workflowActions: [
        {
          workflowId: 'demo-verified-wf', stepId: 'read_inputs', action: 'readFile',
          input: { path: 'q1.md' }, result: { bytes: 120 },
          startedAt: '2026-03-01T09:00:01.000Z', durationMs: 4
        }
      ],
      handoffTasks: [
        { taskId: 'h1', from: 'planner', to: 'executor', operation: 'writeFile', path: 'out.txt', status: 'validated' }
      ],
      providerRequests: [],
      modelResponses: [],
      workspaceOperations: [],
      events: []
    },
    verificationEvent: { type: 'run.verification_passed', payload: { status: 'passed' } },
    evaluation: {
      effectiveness: { status: 'passed', postconditionsPassed: 1, postconditionsFailed: 0, errors: [] },
      efficiency: { durationMs: 1200, workflowSteps: 1, providerRequests: 1, modelResponses: 1, workspaceOperations: 1, mutationCount: 1, retryCount: 0 },
      violations: { status: 'none', items: [] }
    },
    consequence: {
      mutations: [{ operation: 'writeFile', path: 'reports/q3/compliance-summary.md', historyId: 12 }],
      created: [{ operation: 'writeFile', path: 'reports/q3/compliance-summary.md', historyId: 12, type: 'file' }],
      updated: [], renamed: [], deleted: [],
      notifications: [], externalEffects: [],
      verification: { postconditionsStatus: 'passed', violationsStatus: 'none' }
    }
  });

  // ── Verification failure → open run triage (the "run 102" blocker) ──
  const failedTicket = (await store.createTicketWithEvent({
    ticket: baseTicket(agent, {
      objective: 'Generate vendor risk report (verification failed → run triage)',
      status: 'failed'
    }),
    eventPayload: { source: 'operator-fixture' }
  })).ticket;
  const failedRun = await seedTerminalRun(store, {
    ticket: failedTicket,
    agent,
    status: 'failed',
    error: 'Verification failed: 1 postcondition did not pass',
    replaySnapshot: {
      terminalStatus: 'failed',
      failureReason: 'Verification failed: 1 postcondition did not pass',
      parsedModelPlans: [],
      providerRequests: [],
      modelResponses: [],
      workspaceOperations: [],
      events: []
    },
    verificationEvent: {
      type: 'run.verification_failed',
      payload: { status: 'failed', error: 'Verification failed: 1 postcondition did not pass' }
    },
    evaluation: {
      effectiveness: { status: 'failed', postconditionsPassed: 0, postconditionsFailed: 1, errors: ['Verification failed: 1 postcondition did not pass'] },
      efficiency: { durationMs: 1200, workflowSteps: 0, providerRequests: 1, modelResponses: 1, workspaceOperations: 0, mutationCount: 0, retryCount: 0 },
      violations: { status: 'none', items: [] }
    },
    consequence: {
      mutations: [], created: [], updated: [], renamed: [], deleted: [],
      notifications: [], externalEffects: [],
      verification: { postconditionsStatus: 'failed', violationsStatus: 'none' }
    }
  });
  await store.createRunTriage({
    runId: failedRun.id,
    triage: {
      reasonCode: 'verification_failed',
      summary: 'Verification failed: 1 postcondition did not pass',
      requiredDecision: 'review_failure',
      evidenceRefs: ['event:run.verification_failed', 'replay:failure'],
      allowedActions: ['review', 'rerun_from_start'],
      prohibitedActions: ['mark_completed_without_verification']
    }
  });

  // ── Blocked tickets with open ticket-level triage (inbox blocker threads) ──
  const authorityTriage = {
    required: true,
    reasonCode: 'authority_blocked',
    summary: "Objective requires writable scope outside this ticket's granted paths",
    requiredDecision: 'change_scope',
    evidenceRefs: ['event:ticket.blocked', 'ticket:feasibility'],
    allowedActions: ['review', 'edit_ticket'],
    prohibitedActions: ['start_run_without_scope_change'],
    createdAt: new Date().toISOString(),
    resolvedAt: null, resolvedBy: null, resolution: null
  };
  const blockedTicketAuthority = (await store.createTicketWithEvent({
    ticket: baseTicket(agent, {
      objective: 'Reorganize protected legal archive (blocked: ticket-level triage)',
      status: 'blocked',
      blockedReason: authorityTriage.summary,
      triage: authorityTriage
    }),
    eventPayload: { source: 'operator-fixture' }
  })).ticket;

  const ambiguousTriage = {
    required: true,
    reasonCode: 'objective_ambiguous',
    summary: 'The objective asks to create a specific number of folders with generated names but does not provide the exact folder names.',
    requiredDecision: 'clarify_objective',
    evidenceRefs: ['objective-contract:gate', 'objective-contract:ambiguous'],
    allowedActions: ['edit_objective', 'clarify_ticket'],
    prohibitedActions: ['mutate_workspace_without_clarification', 'start_run_without_clarification'],
    createdAt: new Date().toISOString(),
    resolvedAt: null, resolvedBy: null, resolution: null
  };
  const blockedTicketAmbiguous = (await store.createTicketWithEvent({
    ticket: baseTicket(agent, {
      objective: 'Create 3 folders each named Michael Jackson songs (blocked: objective clarification)',
      status: 'blocked',
      blockedReason: ambiguousTriage.summary,
      triage: ambiguousTriage
    }),
    eventPayload: { source: 'operator-fixture' }
  })).ticket;

  // ── Watcher provenance chain: watcher → observation → proposal → approved
  // ticket, through the real approval authority (provenance is written by the
  // store, not hand-assembled). ──
  const watcher = (await store.createWatcher({
    value: {
      name: 'Demo Watcher',
      status: 'active',
      workContextId: context.id,
      sourceKind: 'workspace_file',
      sourceRefs: [{ path: 'inbox/demo.txt' }],
      cadence: { mode: 'manual' },
      triggerPolicy: { mode: 'manual' },
      deltaPolicy: { mode: 'hash' },
      actionPolicy: { allowedActions: ['summarize', 'propose_ticket'] },
      triagePolicy: { mode: 'manual' },
      ticketProposalPolicy: { enabled: true },
      notificationPolicy: { mode: 'none' }
    },
    changedBy: 'admin'
  })).watcher;
  const observation = (await store.recordWatcherObservation({
    watcherId: watcher.id,
    expectedRevision: watcher.revision,
    value: {
      watcherId: watcher.id,
      workContextId: watcher.workContextId,
      status: 'changed',
      sourceKind: watcher.sourceKind,
      sourceRefs: watcher.sourceRefs,
      previousHash: null,
      currentHash: 'a'.repeat(64),
      summary: { bytes: 4, lineCount: 1 },
      actionTaken: 'summarized',
      ticketProposalId: null,
      error: null
    },
    changedBy: 'admin',
    advanceCursor: true
  })).observation;
  const proposal = (await store.createWatcherProposal({
    watcherId: watcher.id,
    value: {
      watcherId: watcher.id,
      workContextId: watcher.workContextId,
      observationId: observation.id,
      objective: 'Bulk-process intake backlog (watcher proposal)',
      sourceRefs: watcher.sourceRefs,
      evidenceRefs: [`watcher-observation:${observation.id}`],
      constraints: null,
      authorityLimits: null,
      stopCondition: null,
      receiptExpectation: 'work_receipt'
    },
    changedBy: 'admin'
  })).proposal;
  const approved = await store.approveWatcherProposal({
    proposalId: proposal.id,
    changedBy: 'admin',
    createTicket: async ({ proposal: approvedProposal, source, persistence }) => {
      const created = await store.createTicketWithEvent({
        ticket: baseTicket(agent, {
          objective: approvedProposal.objective,
          status: 'open',
          workContextId: approvedProposal.workContextId,
          source
        }),
        eventPayload: { source: 'watcher_proposal' }
      }, persistence);
      return { ok: true, ticket: created.ticket, created: created.created };
    }
  });

  return {
    agent,
    context,
    watcher,
    observation,
    proposal: approved.proposal,
    watcherTicket: approved.ticket,
    verifiedTicket,
    verifiedRun,
    failedTicket,
    failedRun,
    blockedTicketAuthority,
    blockedTicketAmbiguous
  };
}

module.exports = { seedOperatorFixture, seedTerminalRun, executionPolicy };

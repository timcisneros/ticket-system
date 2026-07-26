#!/usr/bin/env node
'use strict';
// Run Detail evidence clarity — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// Display-only regression. The contract is unchanged from the JSON era: the run
// detail page must explain WHY a run stopped in terms the captured evidence
// actually supports, and must not let absent replay events read as absent evidence.
//
// Repaired, not rewritten. What changed is seeding: runs and their replay
// snapshots are created through the PostgreSQL store instead of by copying
// data/*.json into a DATA_DIR the server no longer reads. The assertions are the
// original ones, still made against rendered HTML.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();

async function main() {
  await withHarness('run detail evidence clarity', async ({ store, workspaceRoot, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `ClarityAgent${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'run-detail-clarity-test'
    })).agent;

    const now = () => new Date().toISOString();
    const makeTicket = async objective => (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'open', createdBy: 'admin', changedBy: 'admin',
        changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'run-detail-clarity-test' }
    })).ticket;

    // Evidence is present in every case. That is the point of cases 2/4: evidence
    // can exist while the replay events array is empty.
    const evidence = {
      providerRequests: [{ request: 1, durationMs: 10 }],
      modelResponses: [{ response: 1, durationMs: 8 }],
      workspaceOperations: [
        { operation: { operation: 'createFolder' }, result: { status: 'created' }, durationMs: 2 }
      ]
    };

    const snapshotFor = (runId, ticketId, events) => ({
      version: 1, runId, ticketId,
      assignedAgentId: agent.id, agentNameSnapshot: agent.name,
      provider: 'openai', model: 'gpt-4.1-mini',
      runtimeEnvelope: {}, ticketObjectiveSnapshot: 'obj', systemInstructionSnapshot: 'sys',
      primitiveContract: {}, workspaceRoot, mainWorkspaceRoot: workspaceRoot,
      executionWorkspaceType: 'main',
      ...evidence,
      parsedModelPlans: [],
      events,
      terminalStatus: 'completed', failureReason: null,
      mutationCount: 0, mutationOutcome: 'no_mutations',
      createdAt: now(), finalizedAt: now()
    });

    const seedRun = async (objective, events) => {
      const ticket = await makeTicket(objective);
      const run = await store.createRun({
        ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
      const claim = await store.claimPendingRun({
        leaseOwner: 'clarity-fixture', leaseDurationMs: 60000, eligibleRunIds: [run.id]
      });
      const started = await store.transitionRun({
        runId: run.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'clarity-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: run.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus: 'completed', leaseOwner: 'clarity-fixture', eventType: 'run.execution_completed',
        eventPayload: { status: 'completed' }
      });
      await store.initializeRunReplay({
        runId: run.id, ticketId: ticket.id, snapshot: snapshotFor(run.id, ticket.id, events)
      });
      return run;
    };

    // Case 1 — completed through the folder-list postcondition, with checked paths.
    const postconditionRun = await seedRun(`clarity postcondition ${STAMP}`, [{
      type: 'run:postcondition_completed',
      message: 'Requested workspace state is already satisfied',
      step: 1, mutatingActionCount: 0,
      checkedPaths: [{ type: 'folderExists', path: 'CaseA' }, { type: 'folderExists', path: 'CaseB' }],
      source: 'pre_model'
    }]);

    // Cases 2/4 — completed through modelPlan.complete: evidence present, NO events.
    const modelCompleteRun = await seedRun(`clarity model complete ${STAMP}`, []);

    // Case 3 — per-response cap truncation deferred a complete:true.
    const capRun = await seedRun(`clarity cap ${STAMP}`, [
      {
        type: 'model:mutating_action_truncated',
        actionCount: 4, mutatingActionCount: 4,
        maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 2,
        executedCount: 2, truncatedCount: 2, step: 1
      },
      { type: 'run:completion_deferred_truncation', message: 'complete:true not honored', step: 1 }
    ]);

    const server = await startServer({});
    const cookie = await server.login();
    const page = async runId => (await server.request('GET', `/runs/${runId}`, { cookie })).body;

    // ── Case 1 ───────────────────────────────────────────────────────────────
    const p1 = await page(postconditionRun.id);
    assert(p1.includes('Why this run stopped'), '1: shows the "Why this run stopped" block');
    assert(p1.includes('<code>postcondition</code>'), '1: source is postcondition');
    assert(p1.includes('required postconditions verified'), '1: explains postconditions were verified');
    assert(p1.includes('CaseA') && p1.includes('CaseB') && p1.includes('Checked paths'),
      '1: lists the checked paths');

    // ── Cases 2/4 ────────────────────────────────────────────────────────────
    const p2 = await page(modelCompleteRun.id);
    assert(p2.includes('<code>model_complete</code>'), '2: source is model_complete');
    assert(p2.includes('available run evidence points to a model complete:true completion')
      && p2.includes('no more specific postcondition event was captured'),
      '2: the explanation stays bounded by the evidence actually captured');
    assert(p2.includes('Absent replay events do not mean the other evidence is missing'),
      '2/4: empty-events wording distinguishes absent events from absent evidence');
    assert(!p2.includes('No replay events captured.'),
      '2/4: the bare "No replay events captured." line is suppressed when evidence exists');
    assert(/1 provider request\(s\),\s*1 model response\(s\),\s*1 workspace action\(s\)/
      .test(p2.replace(/\s+/g, ' ')),
      '2/4: the evidence line reports provider, model, and workspace counts');

    // ── Case 3 ───────────────────────────────────────────────────────────────
    const p3 = await page(capRun.id);
    assert(p3.includes('Action cap applied: model proposed 4 mutating action(s); runtime limit is 2'),
      '3: the cap note reports the proposed count and the limit');
    assert(p3.includes('truncated') && p3.includes('the run continued'),
      '3: the cap note says the response was truncated and the run continued');
    assert(p3.includes('complete:true was not honored for that response'),
      '3: the cap note explains the deferred complete:true');

    // ── Recovery wording ─────────────────────────────────────────────────────
    // Replay evidence and recovery action are distinct labels; the contradictory
    // "Recoverable: Yes" beside "Recovery Available: No" wording is gone.
    assert(p2.includes('Replay Evidence') && !p2.includes('Replay Available'),
      'recovery wording: "Replay Evidence" replaces "Replay Available"');
    assert(p2.includes('Recovery Action') && !p2.includes('Recovery Available'),
      'recovery wording: "Recovery Action" replaces "Recovery Available"');
    assert(p2.includes('Recovery Analysis') && !/<dt>Recoverable<\/dt>/.test(p2),
      'recovery wording: "Recovery Analysis" replaces the bare "Recoverable" label');

    console.log(`\nPASS: run-detail evidence clarity — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'run_detail_clarity' });
}

main().catch(error => {
  console.error(`\nFAIL: run-detail evidence clarity — ${error && error.message ? error.message : error}`);
  process.exit(1);
});

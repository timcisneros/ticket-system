#!/usr/bin/env node
'use strict';
// Manual completion admission — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The completion-gating half of `state-agreement-completion-test.js`, which combines
// two related but distinct terminal-state contracts: what an operator may manually
// mark completed (here), and how a ticket whose run already terminalized converges on
// restart (still open — see A20).
//
// THE CONTRACT: a ticket may only be marked completed when the evidence supports it.
// "Completed" is the strongest claim the system makes about work, and an operator can
// assert it directly, so the gate is the only thing standing between a wish and a
// durable record. Each refusal must also EXPLAIN itself: an unexplained 409 tells an
// operator nothing about what to fix.
//
// Refused when: no attempt exists; the current attempt failed; the current attempt
// was interrupted; triage is unresolved; or a terminal-looking member has not yet
// produced an authoritative attempt disposition.
//
// THE POSITIVE CONTROL IS THE WHOLE TEST. Refusals prove nothing on their own — a
// runtime that refuses every completion satisfies all of them. The sixth case is a
// ticket whose run genuinely completed with verification not required, which MUST be
// accepted and MUST actually persist as completed. Without it this suite would pass
// against a permanently broken endpoint.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

async function main() {
  await withHarness('completion admission', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `CompletionAdmission-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'completion-admission-test'
    })).agent;

    const now = () => new Date().toISOString();
    async function makeTicket(label, requireVerification) {
      const objective = `completion-admission ${label} ${STAMP}`;
      return (await store.createTicketWithEvent({
        ticket: {
          objective, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification, autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
            allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
          },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'completion-admission-test' }
      })).ticket;
    }

    // Established A10 fixture pattern: create → claim → running → terminal. Direct
    // UPDATEs are rejected by the revision and terminal-reopen guards.
    // The run's policy SNAPSHOT is what the gate reads, not the ticket's live policy —
    // correctly, since a policy edited after the fact must not retroactively change
    // what a finished run proved. The fixture therefore has to set it on the run.
    async function makeTerminalRun(ticketId, toStatus, error = null, requireVerification = 'when_declared') {
      const created = await store.createRun({
        ticketId, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification }, status: 'pending'
      });
      const claim = await store.claimPendingRun({
        leaseOwner: 'completion-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
      });
      const started = await store.transitionRun({
        runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'completion-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus, leaseOwner: 'completion-fixture',
        eventType: toStatus === 'completed' ? 'run.execution_completed' : 'run.execution_failed',
        ...(error ? { patch: { error, completedAt: now() } } : { patch: { completedAt: now() } }),
        eventPayload: { status: toStatus }
      });
      const terminal = await store.getRun(created.id);
      await store.transitionTicketAfterRun({ runId: terminal.id });
      return terminal;
    }

    // A completed WORKFLOW run carrying a declared verification contract but no
    // passing verdict — the only shape that makes verification "required".
    async function makeVerificationRun(ticketId) {
      const created = await store.createRun({
        ticketId, agentId: agent.id, agentName: agent.name,
        executionMode: 'workflow', workflowId: `wf-verify-${STAMP}`,
        // The snapshot must carry its OWN workflowId: `normalizeVerificationContractSnapshot`
        // returns null without it, and a null contract means verification is not required.
        verificationContractSnapshot: {
          workflowId: `wf-verify-${STAMP}`,
          workflowName: 'Verification fixture',
          capturedAt: now(),
          postconditions: [{ type: 'fileExists', path: `verify-${STAMP}.txt` }]
        },
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'when_declared' }, status: 'pending'
      });
      const claim = await store.claimPendingRun({
        leaseOwner: 'completion-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
      });
      const started = await store.transitionRun({
        runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'completion-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus: 'completed', leaseOwner: 'completion-fixture', eventType: 'run.execution_completed',
        patch: { completedAt: now() }, eventPayload: { status: 'completed' }
      });
      return store.getRun(created.id);
    }

    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const cookie = await server.login();

    // T2 Tranche 5: the manual-completion surface is RETIRED. Completion
    // authority is settlement-only; the generic PATCH refuses every request
    // with one canonical retirement message regardless of ticket state.
    const complete = (ticketId) =>
      server.request('PATCH', `/api/tickets/${ticketId}/status`, { cookie, body: { status: 'completed' } });
    const RETIRED = /Generic Ticket lifecycle status mutation is retired/;

    async function refuses(label, ticketId) {
      scenariosRun += 1;
      const before = (await store.getTicket(ticketId)).status;
      const response = await complete(ticketId);
      assert(response.statusCode === 409,
        `${label}: the retired surface refuses with 409 (HTTP ${response.statusCode})`);
      let body = {};
      try { body = JSON.parse(response.body); } catch (_) { /* html error page */ }
      assert(RETIRED.test(String(body.error || '')),
        `${label}: the refusal names the retirement and the intent surfaces`);
      const after = await store.getTicket(ticketId);
      assert(after.status === before,
        `${label}: the refused completion did not change the ticket (${before} → ${after.status})`);
      assert(after.status !== 'completed',
        `${label}: the ticket is emphatically not completed`);
    }

    // ── 1. No run at all ────────────────────────────────────────────────────
    const noRun = await makeTicket('no-run', 'never');
    await refuses('no-run', noRun.id);

    // ── 2. The current attempt failed ───────────────────────────────────────
    const failedTicket = await makeTicket('failed-run', 'never');
    await makeTerminalRun(failedTicket.id, 'failed', 'the run failed');
    await refuses('failed-run', failedTicket.id);

    // ── 3. The current attempt was interrupted ──────────────────────────────
    const interruptedTicket = await makeTicket('interrupted-run', 'never');
    await makeTerminalRun(interruptedTicket.id, 'interrupted');
    await refuses('interrupted-run', interruptedTicket.id);

    // ── 4. Unresolved triage ────────────────────────────────────────────────
    const triageTicket = await makeTicket('triage', 'never');
    const triageRun = await makeTerminalRun(triageTicket.id, 'completed');
    await store.reopenTicket({ ticketId: triageTicket.id });
    await store.createRunTriage({
      runId: triageRun.id,
      triage: {
        required: true, reasonCode: 'review', requiredDecision: 'operator_review',
        allowedActions: ['edit_ticket'], prohibitedActions: ['complete_without_review']
      }
    });
    await refuses('triage', triageTicket.id);

    // ── 5. A terminal-looking member is not an attempt disposition ──────────
    // This fixture deliberately stops before the kernel projection. Manual
    // completion may not rediscover a topology or promote the member on its own;
    // the current attempt must first carry its authoritative disposition.
    const verifyTicket = await makeTicket('verification', 'when_declared');
    await makeVerificationRun(verifyTicket.id);
    await refuses('unsettled-attempt', verifyTicket.id);

    // ── 6. POSITIVE CONTROL — a genuinely completed run is accepted ─────────
    // Five refusals prove nothing without this: a runtime refusing every completion
    // would satisfy all of them.
    scenariosRun += 1;
    const okTicket = await makeTicket('accepted', 'never');
    // makeTerminalRun settles through the canonical authority internally.
    await makeTerminalRun(okTicket.id, 'completed');
    assert((await store.getTicket(okTicket.id)).status === 'completed',
      '6: settlement completes a fully-terminal completed attempt (canonical authority)');
    // The retired surface STILL refuses even for this genuinely completed
    // Ticket — proving no independent completion path exists.
    const retiredStillRefuses = await complete(okTicket.id);
    let retiredBody = {};
    try { retiredBody = JSON.parse(retiredStillRefuses.body); } catch (_) {}
    assert(retiredStillRefuses.statusCode === 409 &&
      RETIRED.test(String(retiredBody.error || '')),
      '6: even a completed Ticket cannot be mutated through the retired surface');

    // The accepted path must not have been a blanket accept: re-check one refusal
    // still refuses on the same server, ruling out order-dependent behaviour.
    scenariosRun += 1;
    const recheck = await complete(failedTicket.id);
    assert(recheck.statusCode >= 400,
      `7: a failed-run ticket is still refused after a successful completion elsewhere (HTTP ${recheck.statusCode})`);
    assert((await store.getTicket(failedTicket.id)).status !== 'completed',
      '7: the failed-run ticket remains uncompleted');

    assertScenariosExecuted({
      label: 'completion admission',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 22,
      minScenarios: 7
    });
    console.log(`\nPASS: manual completion admission — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'completion_admission' });
}

main().catch(error => {
  console.error(`\nFAIL: manual completion admission — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

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
// Refused when: no run exists; the latest run failed; the latest run was interrupted;
// triage is unresolved; or verification was declared and no passing verdict exists.
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
      return store.getRun(created.id);
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

    const complete = (ticketId) =>
      server.request('PATCH', `/api/tickets/${ticketId}/status`, { cookie, body: { status: 'completed' } });

    async function refuses(label, ticketId, reasonPattern) {
      scenariosRun += 1;
      const before = (await store.getTicket(ticketId)).status;
      const response = await complete(ticketId);
      assert(response.statusCode >= 400 && response.statusCode < 500,
        `${label}: manual completion is refused (HTTP ${response.statusCode})`);
      let body = {};
      try { body = JSON.parse(response.body); } catch (_) { /* html error page */ }
      const explanation = String(body.error || response.body || '');
      assert(reasonPattern.test(explanation),
        `${label}: the refusal explains itself — expected ${reasonPattern} in "${explanation.slice(0, 140)}"`);
      const after = await store.getTicket(ticketId);
      assert(after.status === before,
        `${label}: the refused completion did not change the ticket (${before} → ${after.status})`);
      assert(after.status !== 'completed',
        `${label}: the ticket is emphatically not completed`);
    }

    // ── 1. No run at all ────────────────────────────────────────────────────
    const noRun = await makeTicket('no-run', 'never');
    await refuses('no-run', noRun.id, /run|execution|evidence/i);

    // ── 2. The latest run failed ────────────────────────────────────────────
    const failedTicket = await makeTicket('failed-run', 'never');
    await makeTerminalRun(failedTicket.id, 'failed', 'the run failed');
    await refuses('failed-run', failedTicket.id, /fail/i);

    // ── 3. The latest run was interrupted ───────────────────────────────────
    const interruptedTicket = await makeTicket('interrupted-run', 'never');
    await makeTerminalRun(interruptedTicket.id, 'interrupted');
    await refuses('interrupted-run', interruptedTicket.id, /interrupt/i);

    // ── 4. Unresolved triage ────────────────────────────────────────────────
    const triageTicket = await makeTicket('triage', 'never');
    const triageRun = await makeTerminalRun(triageTicket.id, 'completed');
    await store.createRunTriage({
      runId: triageRun.id,
      triage: {
        required: true, reasonCode: 'review', requiredDecision: 'operator_review',
        allowedActions: ['edit_ticket'], prohibitedActions: ['complete_without_review']
      }
    });
    await refuses('triage', triageTicket.id, /triage/i);

    // ── 5. Verification required but not passed ─────────────────────────────
    // RESOLVED by reading `isRunVerificationRequired`, which is narrower than the
    // policy field alone. Verification is required only when ALL of these hold:
    //   * the run's policy snapshot says `when_declared` — note `'always'` returns
    //     FALSE here, which is why an earlier `'always'` fixture was accepted
    //   * the run is a WORKFLOW run with a workflowId
    //   * the run captured a verification contract carrying at least one postcondition
    // With that state and no verified objective-success evidence, completion must be
    // refused. The historical assertion is real; only the fixture was wrong.
    const verifyTicket = await makeTicket('verification', 'when_declared');
    await makeVerificationRun(verifyTicket.id);
    await refuses('verification', verifyTicket.id, /verif/i);

    // ── 6. POSITIVE CONTROL — a genuinely completed run is accepted ─────────
    // Five refusals prove nothing without this: a runtime refusing every completion
    // would satisfy all of them.
    scenariosRun += 1;
    const okTicket = await makeTicket('accepted', 'never');
    await makeTerminalRun(okTicket.id, 'completed');
    const accepted = await complete(okTicket.id);
    assert(accepted.statusCode === 200,
      `6: a completed, unverified-by-policy run IS accepted (HTTP ${accepted.statusCode}: ${String(accepted.body).slice(0, 160)})`);
    const persisted = await store.getTicket(okTicket.id);
    assert(persisted.status === 'completed',
      `6: the accepted completion actually persisted (${persisted.status})`);
    assert(persisted.changedBy === 'admin',
      '6: the completion records the operator who made the claim');

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

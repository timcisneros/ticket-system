#!/usr/bin/env node
'use strict';
// Startup state convergence — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// The second half of `state-agreement-completion-test.js`. Its first half — what an
// operator may manually mark completed — lives in `completion-admission-test.js`.
// This half covers the other direction: what the RUNTIME concludes at startup about
// tickets whose runs already finished.
//
// THE CRASH WINDOW. `run.terminalized` and the ticket's finalization are separate
// durable steps. A process that dies between them leaves a run that is finished and a
// ticket that still says `in_progress` — a lie about live work that no scheduler will
// ever revisit, because the run is not stale and its evidence is not incomplete.
// `reconcileUnfinalizedTicketsOnStartup` is the only thing that heals it.
//
// WHAT MUST BE TRUE:
//   * a terminalized COMPLETED run converges its ticket to completed
//   * a terminalized FAILED run converges to failed and NEVER to completed
//   * a terminalized INTERRUPTED run converges to open, starting no new run
//   * reconciliation reads EXISTING evidence rather than inventing it
//   * already-consistent state is left alone
//   * a second restart changes nothing further
//
// TWO RECONCILERS, NOT ONE. `interruptStaleRunsOnStartup` runs first and handles
// terminal runs whose EVIDENCE is incomplete (`readRunsNeedingTerminalReconciliation`
// → `reconcileTerminalRun`); `reconcileUnfinalizedTicketsOnStartup` runs after and
// handles runs whose evidence is complete but whose TICKET is stuck. Scenario 4 covers
// the first path and was originally written as a negative control on the mistaken
// assumption there was only the second — a completed run missing `run.terminalized`
// does converge, but only after startup supplies the missing evidence, which is the
// contract that actually matters there.
//
// THE NEGATIVE CONTROLS ARE WHY THIS SUITE IS NOT VACUOUS. "A startup that merely
// leaves everything unchanged must not satisfy the suite" — so scenarios 1-4 demand
// real transitions. The converse trap is a startup that finalizes ANY ticket holding a
// terminal-looking run, which would be worse than the bug it fixes: scenarios 5 and 6
// seed `in_progress` tickets that must NOT move — one with a still-pending sibling run
// (execution could be in flight) and one with no runs at all (no evidence whatsoever).
// A runtime that converges everything fails those two; one that converges nothing
// fails the first four.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

async function main() {
  await withHarness('startup state convergence', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `StartupConvergence-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'startup-state-convergence-test'
    })).agent;

    const now = () => new Date().toISOString();

    async function makeTicket(label, status = 'in_progress') {
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `startup convergence ${label} ${STAMP}`, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification: 'never', autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
            allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
          },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status, createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'startup-state-convergence-test' }
      })).ticket;
    }

    // Established A10 fixture pattern: create → claim → running → terminal → replay.
    // Direct UPDATEs are rejected by the revision and terminal-reopen guards.
    async function makeRun(ticketId, toStatus, { terminalized = true, error = null, held = false } = {}) {
      const created = await store.createRun({
        ticketId, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: { requireVerification: 'never' }, status: 'pending',
        // `held` pins a run in `pending` across boot: an unexpired lease makes it
        // unclaimable by the scheduler, so the in-flight negative control observes the
        // healer's own guard rather than racing the scheduler's first tick.
        ...(held ? {
          leaseOwner: 'startup-convergence-holder',
          leaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
        } : {})
      });
      if (toStatus === 'pending') return store.getRun(created.id);

      const claim = await store.claimPendingRun({
        leaseOwner: 'startup-convergence-fixture', leaseDurationMs: 60000, eligibleRunIds: [created.id]
      });
      const started = await store.transitionRun({
        runId: created.id, expectedRevision: claim.run.revision, fromStatuses: ['pending'],
        toStatus: 'running', leaseOwner: 'startup-convergence-fixture', eventType: 'run.started'
      });
      await store.transitionRun({
        runId: created.id, expectedRevision: started.run.revision, fromStatuses: ['running'],
        toStatus, leaseOwner: 'startup-convergence-fixture',
        eventType: toStatus === 'completed' ? 'run.execution_completed' : 'run.execution_failed',
        patch: { completedAt: now(), ...(error ? { error } : {}) },
        eventPayload: { status: toStatus, ...(error ? { error } : {}) }
      });
      await store.initializeRunReplay({
        runId: created.id, ticketId, snapshot: { runId: created.id, ticketId, terminalStatus: toStatus,
          providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }
      });
      // The evidence the healer keys off. Withheld in scenario 4 on purpose.
      if (terminalized) {
        await store.appendEvent({
          type: 'run.terminalized', ticketId, runId: created.id,
          payload: { status: toStatus, ...(error ? { error } : {}) }
        });
      }
      return store.getRun(created.id);
    }

    const ticketEvents = async ticketId =>
      (await store.listTicketEvents(ticketId, { limit: 200 })).events;
    const runEvents = async (ticketId, runId) =>
      (await ticketEvents(ticketId)).filter(event => event.runId === runId);

    // ── Seed every scenario BEFORE the first boot ───────────────────────────
    // Startup reconciliation runs once, at boot, over whatever it finds. Seeding
    // afterwards would test nothing.
    const completedTicket = await makeTicket('completed');
    const completedRun = await makeRun(completedTicket.id, 'completed');

    const failedTicket = await makeTicket('failed');
    const failedRun = await makeRun(failedTicket.id, 'failed', { error: 'boom' });

    const interruptedTicket = await makeTicket('interrupted');
    const interruptedRun = await makeRun(interruptedTicket.id, 'interrupted', { error: 'process restarted' });

    // Completed run whose terminalization evidence never landed.
    const unterminalizedTicket = await makeTicket('unterminalized');
    const unterminalizedRun = await makeRun(unterminalizedTicket.id, 'completed', { terminalized: false });

    // NEGATIVE CONTROL: a completed+terminalized run with a still-pending sibling.
    // The pending run is created FIRST so the COMPLETED one is the latest. That
    // ordering is the whole point: with a pending latest run the healer would stop at
    // its terminal-status branch and the in-flight guard would never be reached, so
    // the control would prove nothing. Here only the guard stands in the way.
    const inFlightTicket = await makeTicket('in-flight');
    const inFlightPending = await makeRun(inFlightTicket.id, 'pending', { held: true });
    const inFlightDone = await makeRun(inFlightTicket.id, 'completed');

    // NEGATIVE CONTROL: in_progress with no runs at all — no evidence to act on.
    const noRunTicket = await makeTicket('no-runs');

    // Already consistent: nothing for the healer to do.
    const consistentTicket = await makeTicket('consistent', 'completed');
    const consistentRun = await makeRun(consistentTicket.id, 'completed');
    const consistentBefore = await store.getTicket(consistentTicket.id);

    // Six settled tickets carry five runs between them; the in-flight ticket's two
    // runs are counted separately because the scheduler acts on one of them.
    const runsBefore = 5;

    // ── FIRST BOOT ──────────────────────────────────────────────────────────
    const first = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });

    // ── 1. Completed run converges its ticket to completed ──────────────────
    scenariosRun += 1;
    const t1 = await store.getTicket(completedTicket.id);
    assert(t1.status === 'completed',
      `1: a stuck ticket behind a terminalized COMPLETED run converges to completed (got ${t1.status})`);
    assert((await store.getRun(completedRun.id)).status === 'completed',
      '1: convergence did not disturb the run it read');

    // ── 2. Failed run converges to failed, never to completed ───────────────
    scenariosRun += 1;
    const t2 = await store.getTicket(failedTicket.id);
    assert(t2.status === 'failed',
      `2: a stuck ticket behind a terminalized FAILED run converges to failed (got ${t2.status})`);
    assert(t2.status !== 'completed',
      '2: a failed run can never produce a completed ticket');
    assert((await store.getRun(failedRun.id)).status === 'failed',
      '2: the failed run remains failed');

    // ── 3. Interrupted run converges to open ────────────────────────────────
    scenariosRun += 1;
    const t3 = await store.getTicket(interruptedTicket.id);
    assert(t3.status === 'open',
      `3: a stuck ticket behind a terminalized INTERRUPTED run converges to open (got ${t3.status})`);
    assert(t3.status !== 'completed' && t3.status !== 'failed',
      '3: an interrupted run claims neither success nor failure');

    // ── 4. Incomplete terminal EVIDENCE is completed, then converged ────────
    // The first reconciler's path. The ticket does converge — but the contract is that
    // it converges TRUTHFULLY: startup must durably record the terminalization it
    // inferred, not quietly finalize a ticket on evidence that still does not exist.
    // A ticket marked completed with no terminal record behind it is precisely the
    // disagreement this whole suite exists to prevent.
    scenariosRun += 1;
    const t4 = await store.getTicket(unterminalizedTicket.id);
    assert(t4.status === 'completed',
      `4: a completed run with incomplete terminal evidence is reconciled and converges (got ${t4.status})`);
    const healed = (await runEvents(unterminalizedTicket.id, unterminalizedRun.id))
      .filter(event => event.type === 'run.terminalized');
    assert(healed.length === 1,
      `4: startup durably RECORDED the terminalization it acted on, exactly once (got ${healed.length})`);
    assert(healed[0].payload && healed[0].payload.status === 'completed',
      '4: the recorded terminal evidence agrees with the run it was derived from');

    // ── 5. NEGATIVE CONTROL — execution still in flight ─────────────────────
    scenariosRun += 1;
    const t5 = await store.getTicket(inFlightTicket.id);
    assert(t5.status === 'in_progress',
      `5: a ticket with a still-pending run is never finalized (got ${t5.status})`);
    const pendingAfter = (await store.getRun(inFlightPending.id)).status;
    assert(pendingAfter === 'pending',
      `5: the in-flight sibling was left for the scheduler, not terminalized (got ${pendingAfter})`);
    assert((await store.getRun(inFlightDone.id)).status === 'completed',
      '5: the completed sibling is untouched');

    // ── 6. NEGATIVE CONTROL — no runs, no evidence, no convergence ──────────
    // The healer's first guard. A ticket with no runs has nothing that could justify
    // a terminal status, and a startup willing to converge it would be inventing an
    // outcome outright.
    scenariosRun += 1;
    const t6NoRun = await store.getTicket(noRunTicket.id);
    assert(t6NoRun.status === 'in_progress',
      `6: an in_progress ticket with no runs is left alone (got ${t6NoRun.status})`);
    assert((await store.listRunsForTicket({ ticketId: noRunTicket.id, limit: 5 })).runs.length === 0,
      '6: startup started no run for it either');

    // ── 7. Already-consistent state is left alone ───────────────────────────
    scenariosRun += 1;
    const t7 = await store.getTicket(consistentTicket.id);
    assert(t7.status === 'completed', '7: an already-completed ticket stays completed');
    assert(t7.revision === consistentBefore.revision,
      `7: an already-consistent ticket is not rewritten (revision ${consistentBefore.revision} → ${t7.revision})`);
    assert((await runEvents(consistentTicket.id, consistentRun.id))
      .filter(event => event.type === 'run.terminalized').length === 1,
      '7: no second terminalization was emitted for consistent state');

    // ── 8. Convergence created no runs and no duplicate terminal events ─────
    scenariosRun += 1;
    const allRuns = (await Promise.all(
      [completedTicket, failedTicket, interruptedTicket, unterminalizedTicket, noRunTicket, consistentTicket]
        .map(async ticket => (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs)
    )).flat();
    assert(allRuns.length === runsBefore,
      `8: startup convergence created no new runs (${runsBefore} → ${allRuns.length})`);
    for (const [label, ticket, run] of [
      ['completed', completedTicket, completedRun],
      ['failed', failedTicket, failedRun],
      ['interrupted', interruptedTicket, interruptedRun]
    ]) {
      const terminalized = (await runEvents(ticket.id, run.id))
        .filter(event => event.type === 'run.terminalized');
      assert(terminalized.length === 1,
        `8: run ${label} has exactly one run.terminalized after convergence (got ${terminalized.length})`);
    }

    // ── 9. Ticket, run and timeline agree after convergence ─────────────────
    scenariosRun += 1;
    for (const [label, ticket, run, expected] of [
      ['completed', completedTicket, completedRun, 'completed'],
      ['failed', failedTicket, failedRun, 'failed']
    ]) {
      const ticketNow = await store.getTicket(ticket.id);
      const runNow = await store.getRun(run.id);
      assert(ticketNow.status === expected && runNow.status === expected,
        `9: ${label} — ticket and run agree on ${expected} (${ticketNow.status} / ${runNow.status})`);
      const timeline = await ticketEvents(ticket.id);
      assert(timeline.some(event => event.runId === run.id && event.type === 'run.terminalized'),
        `9: ${label} — the ticket timeline carries the run's terminal evidence`);
      const replay = await store.readRunReplay(run.id);
      assert(replay && replay.snapshot && replay.snapshot.terminalStatus === expected,
        `9: ${label} — the durable replay snapshot agrees with the converged status`);
    }

    // ── 10. A SECOND RESTART changes nothing ────────────────────────────────
    // Recovery must be idempotent: converged tickets are no longer `in_progress`, so
    // the healer must not revisit them, and nothing may be double-counted.
    scenariosRun += 1;
    const snapshotBefore = {
      statuses: await Promise.all([completedTicket, failedTicket, interruptedTicket, unterminalizedTicket,
        noRunTicket, consistentTicket].map(async t => (await store.getTicket(t.id)).status)),
      revisions: await Promise.all([completedTicket, failedTicket, interruptedTicket]
        .map(async t => (await store.getTicket(t.id)).revision)),
      events: await Promise.all([completedTicket, failedTicket, interruptedTicket, unterminalizedTicket,
        noRunTicket, consistentTicket].map(async t => (await ticketEvents(t.id)).length))
    };

    await first.stop();
    await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });

    // The in-flight ticket is deliberately excluded: the scheduler is genuinely
    // executing its pending run, so its state is EXPECTED to move. Asserting stability
    // there would be asserting that live work stalls. The other six are the
    // idempotency subject — every one of them is settled before the first stop.
    const tickets = [completedTicket, failedTicket, interruptedTicket, unterminalizedTicket,
      noRunTicket, consistentTicket];
    const statusesAfter = await Promise.all(tickets.map(async t => (await store.getTicket(t.id)).status));
    assert(JSON.stringify(statusesAfter) === JSON.stringify(snapshotBefore.statuses),
      `10: a second restart changes no ticket status (${snapshotBefore.statuses.join(',')} → ${statusesAfter.join(',')})`);

    const revisionsAfter = await Promise.all([completedTicket, failedTicket, interruptedTicket]
      .map(async t => (await store.getTicket(t.id)).revision));
    assert(JSON.stringify(revisionsAfter) === JSON.stringify(snapshotBefore.revisions),
      '10: a second restart rewrites no converged ticket');

    const eventsAfter = await Promise.all(tickets.map(async t => (await ticketEvents(t.id)).length));
    assert(JSON.stringify(eventsAfter) === JSON.stringify(snapshotBefore.events),
      `10: a second restart appends no duplicate events (${snapshotBefore.events.join(',')} → ${eventsAfter.join(',')})`);

    const runsAfter = (await Promise.all(tickets.map(async ticket =>
      (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs))).flat();
    assert(runsAfter.length === runsBefore,
      `10: a second restart creates no runs (${runsBefore} → ${runsAfter.length})`);
    for (const [label, ticket, run] of [
      ['completed', completedTicket, completedRun],
      ['failed', failedTicket, failedRun],
      ['interrupted', interruptedTicket, interruptedRun]
    ]) {
      assert((await runEvents(ticket.id, run.id))
        .filter(event => event.type === 'run.terminalized').length === 1,
        `10: run ${label} still has exactly one run.terminalized after the second restart`);
    }

    assertScenariosExecuted({
      label: 'startup state convergence',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 30,
      minScenarios: 10
    });
    console.log(`\nPASS: startup state convergence — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'startup_convergence' });
}

main().catch(error => {
  console.error(`\nFAIL: startup state convergence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});

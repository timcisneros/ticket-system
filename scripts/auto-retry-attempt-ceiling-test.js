#!/usr/bin/env node
'use strict';

// Tranche 5: the attempt ceiling, proved at the authority that ENFORCES it.
//
// WHY THIS EXISTS. `auto-retry-bounds-test` asserts run COUNTS at the ceiling
// and passes — but the mutation `auto-retry-ignores-attempt-ceiling`, which
// turns the server's `attemptCount >= maxAttempts` pre-check into `>`,
// SURVIVED it. Instrumenting the decision showed why: with the pre-check
// relaxed the retry is assessed ELIGIBLE and proceeds, and is then refused by a
// different authority entirely —
//
//   RUN_BUDGET_EXHAUSTED: ticket 3 already has 2 of 2 admitted attempts
//
// raised inside run admission in the store. The counts the suite asserts are
// therefore preserved by the durable authority no matter what the pre-check
// decides, so the suite could never have caught that mutation. The server-side
// comparison is redundant defence in depth; it is not the ceiling.
//
// This suite proves the ceiling where it actually lives, so the invariant has
// an owner that fails when it is broken.
//
// ATTEMPT SEMANTICS, STATED RATHER THAN ASSUMED. `maxAttempts` bounds TOTAL
// admitted attempts, not retries — the initial execution is attempt 1. An
// attempt is one kernel-owned atomic admission wave, whether that wave contains
// one Run or many. Allocation topology is not attempt identity.

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');

const STAMP = `arc-${Date.now()}`;
const ACTOR = 'auto-retry-attempt-ceiling-test';

// Built through the canonical authority rather than hand-rolled: the snapshot
// carries a hash over its own fields, so a literal is refused as unauthorized.
const { buildRuntimeBudgetSnapshot } = require('../runtime/runtime-budget-contract');

const budgetSnapshot = (maxAttempts) => buildRuntimeBudgetSnapshot({
  runtimeLimits: {
    maxAttempts,
    maxExecutionSteps: 6,
    maxModelRequestsPerRun: 4,
    maxWorkspaceOperationsPerRun: 20,
    maxProcessOperationsPerRun: 2,
    maxBrowserOperationsPerRun: 2,
    maxRuntimeDurationMs: 600_000,
    maxOutputArtifactBytesPerRun: 1_048_576,
    revision: 1
  },
  executionPolicy: { allowParallelRuns: false }
});

async function main() {
  await withHarness('auto retry attempt ceiling', async ({ store }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };

    // A real configured agent: Runs carry a foreign key to one.
    const agent = (await store.createConfiguredAgent({
      value: {
        name: `Ceiling Agent ${STAMP}`, provider: 'openai',
        model: 'gpt-ceiling-fixture', apiKey: ''
      },
      changedBy: ACTOR
    })).agent;

    const makeTicket = async (objective) => await store.createTicket({
      objective: `${objective} ${STAMP}`,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      executionMode: 'agent'
    });

    const draft = (ticketId, maxAttempts, extra = {}) => ({
      ticketId,
      agentId: agent.id,
      agentName: agent.name,
      status: 'pending',
      executionMode: 'agent',
      runtimeBudgetSnapshot: budgetSnapshot(maxAttempts),
      ...extra
    });

    // Real retries reopen the ticket before admitting the next attempt, which
    // is why the ceiling is the only thing standing between a failed run and
    // another one. Reopening is reproduced here rather than bypassed.
    // A retry is only created after its predecessor is terminal, so the same
    // ordering is reproduced here. Without it the store refuses for a reason
    // that has nothing to do with the ceiling.
    const terminalizePredecessors = async ticketId => {
      const runs = (await store.listRunsForTicket({ ticketId, limit: 50 })).runs;
      let routeRun = null;
      for (const run of runs) {
        if (!['pending', 'running'].includes(run.status)) continue;
        const transitioned = await store.transitionRun({
          runId: run.id,
          expectedRevision: run.revision,
          fromStatuses: [run.status],
          toStatus: 'failed',
          eventType: 'run.execution_failed',
          eventPayload: { source: ACTOR }
        });
        routeRun = transitioned.run;
      }
      if (routeRun) await store.transitionTicketAfterRun({ runId: routeRun.id });
    };
    const reopenIfNeeded = async ticketId => {
      const ticket = await store.getTicket(ticketId);
      if (ticket.status === 'open') return;
      await store.reopenTicket({ ticketId, rerunMode: 'auto_retry' });
    };
    const admitBatch = async (ticketId, drafts) => {
      await terminalizePredecessors(ticketId);
      await reopenIfNeeded(ticketId);
      return store.createRunsAndStartTicket({
        ticketId, runDrafts: drafts, runEventPayload: () => ({ source: ACTOR })
      });
    };
    const admit = (ticketId, maxAttempts, extra = {}) =>
      admitBatch(ticketId, [draft(ticketId, maxAttempts, extra)]);

    const refused = async (promise, why) => {
      let error = null;
      try { await promise; } catch (caught) { error = caught; }
      assert.ok(error, `${why} — expected a refusal, got success`);
      assert.equal(error.code, 'RUN_BUDGET_EXHAUSTED',
        `${why} — expected RUN_BUDGET_EXHAUSTED, got ${error.code}: ${error.message}`);
      return error;
    };

    const attemptsOf = async ticketId => store.countTicketAttempts(ticketId);

    const runCount = async ticketId => Number((await store.pool.query(
      `SELECT count(*) AS n FROM ${store.table('runs')} WHERE ticket_id = $1`,
      [ticketId])).rows[0].n);

    // ── BELOW THE CEILING: one more attempt may be admitted ────────────────
    {
      const ticket = await makeTicket('ceiling below');
      await admit(ticket.id, 3);
      ok(await attemptsOf(ticket.id) === 1,
        'the initial execution is attempt 1, not attempt 0');
      await admit(ticket.id, 3);
      ok(await attemptsOf(ticket.id) === 2,
        'a second attempt is admitted while below the ceiling');
    }

    // ── EXACTLY AT THE CEILING: nothing further is admitted ────────────────
    {
      const ticket = await makeTicket('ceiling exact');
      await admit(ticket.id, 2);
      await admit(ticket.id, 2);
      ok(await attemptsOf(ticket.id) === 2, 'the ticket sits exactly at its ceiling');

      const before = await runCount(ticket.id);
      const error = await refused(admit(ticket.id, 2),
        'an attempt at the ceiling');
      ok(/already has 2 of 2|2 of 2 attempts/.test(error.message),
        `the refusal names the exact ceiling it enforced (${error.message})`);
      ok(error.details && error.details.dimension === 'attempt',
        'and refuses on the attempt dimension specifically');
      ok(error.details.limit === 2 && error.details.currentCommittedUsage === 2,
        'and reports committed usage against that limit');

      // THE REFUSAL COMMITS NOTHING. This is the boundary the ceiling exists
      // to hold: no Run row, and therefore no ordinal, reservation, replay,
      // receipt or scheduler claim downstream of one.
      ok(await runCount(ticket.id) === before,
        'a refused attempt creates no Run');
      ok(await attemptsOf(ticket.id) === 2,
        'and does not advance the attempt count');
      const spend = await store.pool.query(
        `SELECT
           (SELECT count(*) FROM ${store.table('economic_request_reservations')} r
             JOIN ${store.table('runs')} rn ON rn.id = r.run_id WHERE rn.ticket_id = $1) AS reservations,
           (SELECT count(*) FROM ${store.table('operation_receipts')} o
             JOIN ${store.table('runs')} rn ON rn.id = o.run_id WHERE rn.ticket_id = $1) AS receipts`,
        [ticket.id]);
      ok(Number(spend.rows[0].reservations) === 0 && Number(spend.rows[0].receipts) === 0,
        'a refused attempt creates no reservation and no receipt');
    }

    // ── ABOVE THE CEILING: a lowered ceiling still refuses ─────────────────
    //
    // Reached by admitting under a higher ceiling and then presenting a lower
    // one, which is what a runtime-limits change does to an existing ticket.
    {
      const ticket = await makeTicket('ceiling above');
      await admit(ticket.id, 4);
      await admit(ticket.id, 4);
      await admit(ticket.id, 4);
      ok(await attemptsOf(ticket.id) === 3, 'three attempts exist');
      await refused(admit(ticket.id, 2),
        'an attempt when already ABOVE a lowered ceiling');
      ok(await attemptsOf(ticket.id) === 3,
        'and the count is unchanged by the refusal');
    }

    // ── ONE ATOMIC MULTI-RUN BATCH IS ONE ATTEMPT ─────────────────────────
    {
      const ticket = await makeTicket('ceiling batch');
      await admit(ticket.id, 2);
      await admitBatch(ticket.id, [draft(ticket.id, 2), draft(ticket.id, 2)]);
      ok(await runCount(ticket.id) === 3,
        'the second attempt may contain two atomically admitted Runs');
      ok(await attemptsOf(ticket.id) === 2,
        'the multi-Run batch consumes exactly one remaining attempt');
      await refused(admit(ticket.id, 2), 'the next batch at the ceiling');
    }

    // ── TOPOLOGY DOES NOT DEFINE ATTEMPT IDENTITY ───────────────────────────
    //
    // Sibling Runs of one structured attempt must not each consume the ceiling,
    // or a two-leaf plan would exhaust a ceiling of 2 on its first execution.
    {
      const ticket = await makeTicket('ceiling allocation');
      await admitBatch(ticket.id, [
        draft(ticket.id, 2, { allocationPlanId: 'plan-one' }),
        draft(ticket.id, 2, { allocationPlanId: 'plan-one' })
      ]);
      ok(await runCount(ticket.id) === 2, 'two sibling Runs exist');
      ok(await attemptsOf(ticket.id) === 1,
        'but they are ONE attempt because they were admitted atomically');
      await admitBatch(ticket.id, [draft(ticket.id, 2, { allocationPlanId: 'plan-two' })]);
      ok(await attemptsOf(ticket.id) === 2, 'a second plan is a second attempt');
      await refused(admitBatch(ticket.id, [draft(ticket.id, 2, { allocationPlanId: 'plan-three' })]),
        'a third plan at a ceiling of 2');
    }

    // ── THE CEILING SURVIVES A RESTART ─────────────────────────────────────
    //
    // Counted from durable rows, never from process state, so a fresh store
    // handle — the thing a restarted process has — enforces the same bound.
    {
      const ticket = await makeTicket('ceiling restart');
      await admit(ticket.id, 2);
      await admit(ticket.id, 2);

      const { PostgresRuntimeStore } = require('../persistence/postgres/store');
      const fresh = new PostgresRuntimeStore({
        connectionString: store.connectionString || process.env.TEST_DATABASE_URL,
        schema: store.schema
      });
      try {
        let error = null;
        try {
          await terminalizePredecessors(ticket.id);
          await reopenIfNeeded(ticket.id);
          await fresh.createRunsAndStartTicket({
            ticketId: ticket.id,
            runDrafts: [draft(ticket.id, 2)],
            runEventPayload: () => ({ source: ACTOR })
          });
        } catch (caught) { error = caught; }
        ok(error && error.code === 'RUN_BUDGET_EXHAUSTED',
          'a fresh process enforces the ceiling from durable state alone');
        ok(await attemptsOf(ticket.id) === 2,
          'and the attempt count is not reset by restarting');
      } finally {
        await fresh.close();
      }
    }

    console.log(`\nauto retry attempt ceiling test passed — ${assertions} assertions`);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
